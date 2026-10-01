/**
 * The run state machine under the awkward orderings: 停止 landing in the middle
 * of a turn's final write, before the turn has a run at all, or on a follow-up
 * waiting behind a turn that has already answered; the shutdown cancelling a
 * start; a background 压缩 against turns; and what 回收 may take away. Every
 * test here fails on the code that shipped before these were fixed.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isToolUIPart, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import type { ChunkHub } from "./chunk-hub.js";
import { createEngineRegistry, type EngineContext, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import { createQueueStore } from "./queue.js";
import { RESTART_RESUME_TEXT } from "./restart.js";
import { createRunManager, STOP_INTERRUPT_TEXT, TurnStartCancelledError, type RunManager, type RunManagerStats } from "./runs.js";
import { createProjectStore, type ProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore, type ThreadStore } from "./store/threads.js";
import type { ChangeStats, HarnessState, Project, ThreadMessageMetadata, ThreadRecord } from "./types.js";
import { startSetup } from "./worktree-setup.js";

const execFileAsync = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7415";

const dirs: string[] = [];
const apps: VgentApp[] = [];
const managers: RunManager[] = [];

afterEach(async () => {
  // Runs first: a turn still going would write into a directory about to go.
  await Promise.all(managers.splice(0).map((runs) => runs.stopAll()));
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-state-"));
  dirs.push(dir);
  return dir;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, attempts = 300): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待超时: ${what}`);
}

/** `promise`, or a clear failure when it does not settle — what a hang on the old code looks like. */
async function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${ms}ms 内没有结束`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a promise came to, without letting a rejection go unobserved. */
const outcomeOf = <T>(promise: Promise<T>): Promise<T | unknown> => promise.then((value) => value, (error: unknown) => error);

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

/** A queued or sent attachment, the way the composer sends one: a data URL. */
const picture = { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,iVBORw0KGgo=", filename: "a.png" };

async function drain(hub: ChunkHub): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of hub.subscribe()) chunks.push(chunk);
  return chunks;
}

// --- a scriptable engine ------------------------------------------------------

const part = (value: unknown) => value as TextStreamPart<ToolSet>;

function textOf(message: ModelMessage | undefined): string {
  if (message == null) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((entry) => ("text" in entry && typeof entry.text === "string" ? entry.text : "")).join("");
}

interface Script {
  text: string;
  abortSignal: AbortSignal;
  ctx: EngineContext;
  /** The runtime now holds an open turn, the way it does while an approval is pending. */
  unfinished(): void;
}
type Behavior = (script: Script) => AsyncGenerator<TextStreamPart<ToolSet>>;

const answer = (reply = "好的"): Behavior =>
  async function* () {
    yield part({ type: "start" });
    yield part({ type: "text-start", id: "t1" });
    yield part({ type: "text-delta", id: "t1", text: reply });
    yield part({ type: "text-end", id: "t1" });
  };

const askApproval: Behavior = async function* ({ unfinished }) {
  yield part({ type: "start" });
  const call = { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "echo hi" }, providerExecuted: true };
  yield part(call);
  unfinished();
  yield part({ type: "tool-approval-request", approvalId: "ap-1", toolCall: call });
};

const abortedSignal = (abortSignal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (abortSignal.aborted) resolve();
    else abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

const untilAborted: Behavior = async function* ({ abortSignal }) {
  yield part({ type: "start" });
  await abortedSignal(abortSignal);
};

/** Fires a state write of its own that is not awaited, then dies: the write holds the run's write lock while the failure is being recorded. */
const failAfterSavingState: Behavior = async function* ({ ctx }) {
  yield part({ type: "start" });
  Promise.resolve(ctx.saveTaskState?.({} as never)).catch(() => {});
  throw new Error("引擎炸了");
};

/** What a synchronous call threw, to match on. */
function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * `beforeStream` runs inside `stream()` before it hands the stream back: one
 * that rejects takes the turn down its failure path, not its stream's.
 */
function createEngine(behavior: Behavior = answer(), beforeStream?: (abortSignal: AbortSignal) => Promise<void>) {
  const created: EngineContext[] = [];
  const prompts: string[] = [];
  const finished: number[] = [];
  const destroyed: number[] = [];
  const factory: EngineFactoryOverride = {
    async create(ctx): Promise<EngineRunner> {
      created.push(ctx);
      const id = created.length;
      let unfinished = false;
      return {
        hasUnfinishedTurn: () => unfinished,
        async stream({ messages, abortSignal }) {
          const text = textOf(messages.at(-1));
          prompts.push(text);
          await beforeStream?.(abortSignal);
          const script: Script = {
            text,
            abortSignal,
            ctx,
            unfinished: () => {
              unfinished = true;
            },
          };
          return { stream: ReadableStream.from(behavior(script)) as ReadableStream<TextStreamPart<ToolSet>> };
        },
        async finish() {
          finished.push(id);
        },
        async destroy() {
          destroyed.push(id);
        },
      };
    },
  };
  return { factory, created, prompts, finished, destroyed };
}

// --- a run manager to poke at -----------------------------------------------

interface HarnessOptions {
  behavior?: Behavior;
  beforeStream?: (abortSignal: AbortSignal) => Promise<void>;
  mode?: "plan";
  changeStats?: (thread: ThreadRecord) => Promise<ChangeStats | undefined>;
  savePlan?: (threadId: string, content: string) => Promise<void>;
  whenWorkspaceReady?: (id: string) => Promise<void>;
  ensureAvailable?: EngineFactoryOverride["ensureAvailable"];
  stopTimeoutMs?: number;
  /** Stands between the manager and the store, to hold one kind of write back. */
  wrapThreads?: (threads: ThreadStore, around: { projects: ProjectStore; project: Project }) => ThreadStore;
  /** An existing data directory: the same tasks as a manager before this one (the next launch). */
  dir?: string;
}

async function harness(options: HarnessOptions = {}) {
  const dir = options.dir ?? (await tempDir());
  const threads = createThreadStore(dir);
  const projects = createProjectStore(dir);
  const settings = createSettingsStore(dir);
  const project = (await projects.list())[0] ?? (await projects.create({ repoPath: dir }));
  const thread =
    (await threads.list())[0] ??
    (await threads.create({
      projectId: project.id,
      engine: "claude-code",
      ...(options.mode != null ? { mode: options.mode } : {}),
    }));
  const engine = createEngine(options.behavior, options.beforeStream);
  const factory = options.ensureAvailable != null ? { ...engine.factory, ensureAvailable: options.ensureAvailable } : engine.factory;
  const queue = createQueueStore(threads);
  const runs = createRunManager({
    threads: options.wrapThreads?.(threads, { projects, project }) ?? threads,
    projects,
    settings,
    dataDir: dir,
    registry: createEngineRegistry({ "claude-code": factory }),
    queue,
    ...(options.changeStats != null ? { changeStats: options.changeStats } : {}),
    ...(options.savePlan != null ? { savePlan: options.savePlan } : {}),
    ...(options.whenWorkspaceReady != null ? { whenWorkspaceReady: options.whenWorkspaceReady } : {}),
    ...(options.stopTimeoutMs != null ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
  });
  managers.push(runs);
  return { dir, threads, projects, project, thread: { id: thread.id }, queue, runs, engine };
}

type Harness = Awaited<ReturnType<typeof harness>>;

const slotFree = (h: Harness) => waitFor("run slot released", () => h.runs.stats().runs === 0);

/** 停止 has landed: it wrote `interrupted` and is now waiting for the run to wind down. */
const stopLanded = (h: Harness) =>
  waitFor("停止 wrote interrupted", async () => (await h.threads.get(h.thread.id))?.status === "interrupted");

const startWaiting = (h: Harness, count = 1) => waitFor("the start is waiting", () => h.runs.stats().pendingStarts === count);

const IDLE_MANAGER: RunManagerStats = { runs: 0, parked: 0, pendingStarts: 0 };

const isIdle = (stats: RunManagerStats): boolean => (Object.keys(IDLE_MANAGER) as Array<keyof RunManagerStats>).every((key) => stats[key] === IDLE_MANAGER[key]);

/** The manager holds nothing for the thread: no run, no parked engine, no start on its way. */
const expectIdle = async (h: Harness): Promise<void> => {
  await waitFor("the manager to hold nothing", () => isIdle(h.runs.stats()));
  expect(h.runs.stats()).toEqual(IDLE_MANAGER);
};

const turnEndOf = (record: ThreadRecord | undefined, id: string) =>
  (record?.messages.find((message) => message.id === id)?.metadata as ThreadMessageMetadata | undefined)?.turnEnd;

// --- 停止 vs 收尾写入 ---------------------------------------------------------------

describe("停止落在回合的收尾写入之前", () => {
  it("改动统计期间：任务保持 interrupted，队列原地不动，不会自动发下一条", async () => {
    const counting = deferred();
    const release = deferred();
    const h = await harness({
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return { files: 1, additions: 1, deletions: 0 };
      },
    });
    await h.queue.append(h.thread.id, "排队的下一条", "queue");

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "干活")]));
    await counting.promise; // the reply is over; the diff is being counted
    const stopping = h.runs.stop(h.thread.id);
    await stopLanded(h);
    release.resolve();
    await within(stopping);
    await slotFree(h);
    await sleep(100); // room for a dispatcher that must not fire

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(record?.queue).toHaveLength(1);
    expect(h.engine.prompts).toEqual(["干活"]);
    // The log records a stop, not a finished turn.
    expect(turnEndOf(record, "u1")).toMatchObject({ status: "interrupted", reason: STOP_INTERRUPT_TEXT });
  });

  it("计划文档保存期间：同样不会被 idle 盖掉", async () => {
    const saving = deferred();
    const release = deferred();
    const h = await harness({
      mode: "plan",
      savePlan: async () => {
        saving.resolve();
        await release.promise;
      },
    });
    await h.queue.append(h.thread.id, "排队的下一条", "queue");

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "出个计划")]));
    await saving.promise;
    const stopping = h.runs.stop(h.thread.id);
    await stopLanded(h);
    release.resolve();
    await within(stopping);
    await slotFree(h);
    await sleep(100);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(record?.queue).toHaveLength(1);
    expect(h.engine.prompts).toEqual(["出个计划"]);
  });

  it("本来要停在审批上的回合：审批被关掉，引擎被销毁而不是挂起", async () => {
    const counting = deferred();
    const release = deferred();
    const h = await harness({
      behavior: askApproval,
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return undefined;
      },
    });

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "用工具")]));
    await counting.promise; // it would now go on to park on the approval
    const stopping = h.runs.stop(h.thread.id);
    await stopLanded(h);
    release.resolve();
    await within(stopping);
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    // Nothing is left to answer: no open approval for the client to offer.
    const tool = record?.messages.at(-1)?.parts.find(isToolUIPart);
    expect(tool).toMatchObject({ state: "output-error", errorText: STOP_INTERRUPT_TEXT });
    expect(h.runs.stats().parked).toBe(0);
    expect(h.engine.destroyed).toEqual([1]);
    expect(h.engine.finished).toEqual([]);
  });

  it("最终写入已经在路上、回合本来要挂起时落下的停止：审批被关掉，引擎被销毁而不是挂起", async () => {
    const written = deferred();
    const release = deferred();
    const h = await harness({
      behavior: askApproval,
      wrapThreads: (threads) => ({
        ...threads,
        async update(id, patch, guard) {
          const record = await threads.update(id, patch, guard);
          // The turn's own final write is on disk, but from the run's side it has not returned yet.
          if (patch.status === "awaiting-approval") {
            written.resolve();
            await release.promise;
          }
          return record;
        },
      }),
    });

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "用工具")]));
    await written.promise;
    const stopping = h.runs.stop(h.thread.id);
    await stopLanded(h); // `interrupted` is written after the turn's own `awaiting-approval`
    release.resolve();
    await within(stopping);
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    const tool = record?.messages.at(-1)?.parts.find(isToolUIPart);
    expect(tool).toMatchObject({ state: "output-error", errorText: STOP_INTERRUPT_TEXT });
    expect(h.runs.stats().parked).toBe(0);
    expect(h.engine.destroyed).toEqual([1]);
  });

  it("失败收尾在写锁上排队的时候：不会把停止改写成 error", async () => {
    const held = deferred();
    const release = deferred();
    const h = await harness({
      behavior: failAfterSavingState,
      wrapThreads: (threads) => ({
        ...threads,
        async update(id, patch, guard) {
          // The engine's own state write: it takes the write lock and sits on it.
          if ("taskState" in patch) {
            held.resolve();
            await release.promise;
          }
          return threads.update(id, patch, guard);
        },
      }),
    });

    await h.runs.start(h.thread.id, [userMessage("u1", "会炸")]);
    await held.promise;
    await sleep(50); // the failure has been worked out and is waiting behind that write
    const stopping = h.runs.stop(h.thread.id);
    await stopLanded(h);
    release.resolve();
    await within(stopping);
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(record?.error).toBeUndefined();
    expect(turnEndOf(record, "u1")).toMatchObject({ status: "interrupted", reason: STOP_INTERRUPT_TEXT });
  });

  it("可恢复的退出停下的回合走失败收尾：记成 unknown（服务重启），不被改写成 cancelled", async () => {
    const h = await harness({
      beforeStream: async (abortSignal) => {
        await abortedSignal(abortSignal);
        throw new Error("aborted");
      },
    });
    await h.runs.start(h.thread.id, [userMessage("u1", "长活")]);
    await waitFor("engine started", () => h.engine.prompts.length === 1);

    await within(h.runs.stopAll({ recoverRunning: true }));
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(record?.restartRecovery).toEqual(expect.any(String));
    const metadata = record?.messages.find((message) => message.id === "u1")?.metadata as ThreadMessageMetadata;
    expect(metadata.run?.stopReason).toBe("unknown");
  });
});

// --- 启动窗口里的停止 -----------------------------------------------------------------

describe("停止落在回合还没有 run 的窗口里", () => {
  it("等 worktree 的时候：回合不启动，调用方拿到 turn_start_cancelled，任务原样", async () => {
    const workspace = deferred();
    const h = await harness({ whenWorkspaceReady: () => workspace.promise });

    const outcome = outcomeOf(h.runs.start(h.thread.id, [userMessage("u1", "第一句")]));
    await startWaiting(h);

    await within(h.runs.stop(h.thread.id)); // returns at once: it does not wait for the setup
    const error = await within(outcome);
    expect(error).toBeInstanceOf(TurnStartCancelledError);
    expect(error).toMatchObject({ status: 409, code: "turn_start_cancelled" });

    // The setup finishing later must not bring the turn back.
    workspace.resolve();
    await sleep(50);
    expect(h.engine.created).toHaveLength(0);
    expect(await h.threads.get(h.thread.id)).toMatchObject({ status: "idle", messages: [] });
    await expectIdle(h);

    // And the task takes its next message as if nothing had happened.
    await drain(await h.runs.start(h.thread.id, [userMessage("u2", "第二句")]));
    await slotFree(h);
    expect(h.engine.prompts).toEqual(["第二句"]);
    expect((await h.threads.get(h.thread.id))?.status).toBe("idle");
  });

  it("被取消的等待：worktree 事后才建失败，也不会变成没人接的 rejection，也不留那条消息", async () => {
    let fail!: (error: Error) => void;
    const workspace = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const h = await harness({ whenWorkspaceReady: () => workspace });

    const outcome = outcomeOf(h.runs.start(h.thread.id, [userMessage("u1", "第一句")]));
    await startWaiting(h);
    // The worktree has failed on disk already; only the wait has not heard yet.
    await h.threads.update(h.thread.id, { workspaceState: "failed", error: "worktree 没建成" });
    await within(h.runs.stop(h.thread.id));
    expect(await within(outcome)).toBeInstanceOf(TurnStartCancelledError);

    // The creation failing after the turn gave up on it is nobody's business any more (an unhandled rejection would fail this file).
    fail(new Error("worktree 没建成"));
    await sleep(50);
    await expectIdle(h);
    // A failed worktree keeps the message it held back — but this one the user stopped, so it is theirs, not the log's.
    expect((await h.threads.get(h.thread.id))?.messages).toEqual([]);
  });

  it("HTTP：setup 还在跑的时候点停止，POST /api/chat 得到 409，引擎一次都没起", async () => {
    const dir = await tempDir();
    const engine = createEngine();
    const app = makeApp(dir, engine.factory);
    const { thread } = await setupThread(app, dir);

    // A project setup that has not finished: the turn waits for it (`whenSetupSettled`).
    const projectDir = await tempDir();
    await mkdir(join(projectDir, ".vgent"), { recursive: true });
    await writeFile(join(projectDir, ".vgent", "worktrees.json"), JSON.stringify({ "setup-worktree-unix": ["true"], "setup-worktree": ["true"] }));
    await mkdir(join(dir, "workspaces"), { recursive: true });
    const setup = deferred();
    startSetup({
      dataDir: dir,
      threadId: thread.id,
      workspacePath: dir,
      projectPath: projectDir,
      onStatus: async () => {
        await setup.promise;
      },
    });

    try {
      const chat = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] });
      let answered = false;
      void chat.then(() => {
        answered = true;
      });
      // Pressed until the request has reached the wait: a stop before that finds nothing to cancel, which is fine.
      await waitFor("the chat request is cancelled", async () => {
        expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);
        return answered;
      });

      const response = await chat;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "turn_start_cancelled" } });
    } finally {
      setup.resolve();
    }
    await sleep(100);
    expect(engine.created).toHaveLength(0);
    expect(await getThread(app, thread.id)).toMatchObject({ status: "idle", messages: [] });
  });

  it("回合已经开写记录的那一刻：不取消它，等它成为 run 再停掉", async () => {
    const committing = deferred();
    const release = deferred();
    const h = await harness({
      behavior: untilAborted,
      wrapThreads: (threads) => ({
        ...threads,
        async update(id, patch, guard) {
          if (patch.status === "running") {
            committing.resolve();
            await release.promise;
          }
          return threads.update(id, patch, guard);
        },
      }),
    });

    const started = outcomeOf(h.runs.start(h.thread.id, [userMessage("u1", "开跑")]));
    await committing.promise; // past the last look: the record is being written
    const stopping = h.runs.stop(h.thread.id);
    await sleep(50);
    release.resolve();
    // The start itself went through — and the stop caught up with its run.
    expect(await within(started)).not.toBeInstanceOf(Error);
    await within(stopping);
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(turnEndOf(record, "u1")).toMatchObject({ status: "interrupted", reason: STOP_INTERRUPT_TEXT });
  });

  it("还在启动路上的回合算在运行；这期间任务被归档，回合不再启动（409 thread_archived）", async () => {
    const workspace = deferred();
    const h = await harness({ whenWorkspaceReady: () => workspace.promise });

    const outcome = outcomeOf(h.runs.start(h.thread.id, [userMessage("u1", "第一句")]));
    await startWaiting(h);
    expect(h.runs.isRunning(h.thread.id)).toBe(true);

    // Archived underneath the waiting start (the routes refuse that now, but the record is what the start goes by).
    await h.threads.update(h.thread.id, { archivedAt: new Date().toISOString() });
    workspace.resolve();
    expect(await within(outcome)).toMatchObject({ status: 409, code: "thread_archived" });
    expect(h.engine.created).toHaveLength(0);
    expect(await h.threads.get(h.thread.id)).toMatchObject({ status: "idle", messages: [] });
    await expectIdle(h);
    expect(h.runs.isRunning(h.thread.id)).toBe(false);
  });

  it("自动继续的启动也是启动：等可用性检查时算在运行，停止当场取消它", async () => {
    const entered = deferred();
    const h = await harness({
      ensureAvailable: async () => {
        entered.resolve();
        await new Promise<void>(() => {}); // a probe that never answers
      },
    });
    await h.threads.update(h.thread.id, {
      status: "interrupted",
      restartRecovery: "recovery-1",
      messages: [userMessage("u0", "原来的活")],
    });

    const resuming = h.runs.resumeInterrupted(h.thread.id);
    await entered.promise;
    expect(h.runs.isRunning(h.thread.id)).toBe(true);
    expect(h.runs.stats().pendingStarts).toBe(1);

    await within(h.runs.stop(h.thread.id));
    await within(resuming);
    await expectIdle(h);
    const record = await h.threads.get(h.thread.id);
    expect(record?.restartRecovery).toBeUndefined();
    expect(record?.error).toBeUndefined();
    expect(record?.messages.map((message) => message.id)).toEqual(["u0"]);
    expect(h.engine.created).toHaveLength(0);
  });

  it("HTTP：回合还在启动路上时，归档、回收、改模式、压缩、「发送」都按运行中拒绝", async () => {
    const dir = await tempDir();
    const entered = deferred();
    const engine = createEngine();
    // The availability probe is the start's last wait before it commits: it holds the start there.
    const app = makeApp(dir, {
      ...engine.factory,
      ensureAvailable: async () => {
        entered.resolve();
        await new Promise<void>(() => {});
      },
    });
    const { thread } = await setupThread(app, dir);
    const chat = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] });
    await entered.promise;
    // Put there behind the server's back, so no dispatcher picks it up.
    await createThreadStore(dir).update(thread.id, { queue: [{ id: "q1", text: "排队的", createdAt: new Date().toISOString(), mode: "queue" }] });

    const patch = (body: unknown) => request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) });
    for (const refused of [
      await patch({ archived: true }),
      await patch({ mode: "plan" }),
      await postJson(app, `/api/threads/${thread.id}/workspace/reclaim`, {}),
      await postJson(app, `/api/threads/${thread.id}/compact`, {}),
      await postJson(app, `/api/threads/${thread.id}/queue/q1/send`, {}),
    ]) {
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "thread_running" } });
    }
    expect((await getThread(app, thread.id)).archivedAt).toBeUndefined();

    expect((await within(postJson(app, `/api/chat/${thread.id}/stop`, {}))).status).toBe(204);
    const cancelled = await within(chat);
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ error: { code: "turn_start_cancelled" } });
    expect(engine.created).toHaveLength(0);
    expect(await getThread(app, thread.id)).toMatchObject({ status: "idle", messages: [] });
    // Once nothing is on its way, the same edit goes through.
    expect((await patch({ archived: true })).status).toBe(200);
  });

  it("排队消息的启动被停止：停止返回的那一刻，消息已经放回、任务已是 interrupted", async () => {
    const workspace = deferred();
    let slow = false;
    const h = await harness({
      whenWorkspaceReady: () => workspace.promise,
      wrapThreads: (threads) => ({
        ...threads,
        async update(id, patch, guard) {
          // The cleanup's status write takes a moment, as a real disk may.
          if (slow && patch.status === "interrupted") await sleep(50);
          return threads.update(id, patch, guard);
        },
      }),
    });
    await h.queue.append(h.thread.id, "排队的一句", "queue");

    const dispatching = h.runs.dispatchQueue(h.thread.id);
    await startWaiting(h);
    slow = true;
    await within(h.runs.stop(h.thread.id));
    // Read at once, the way a client does after the 204.
    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    expect(record?.queue).toEqual([expect.objectContaining({ text: "排队的一句" })]);
    expect(record?.queue?.[0]?.claimed).toBeFalsy();
    expect(record?.queue?.[0]?.accepted).toBeFalsy();
    await within(dispatching);
    workspace.resolve();
  });

  it("排队消息的启动被停止后的收尾：只在任务还空闲时写 interrupted，不会盖掉紧接着开始的新一轮", async () => {
    const workspace = deferred();
    const arrived = deferred();
    const release = deferred();
    let waits = 0;
    let held = false;
    let cleanup: "wrote" | "refused" | undefined;
    const h = await harness({
      behavior: untilAborted,
      // Only the queued message's start waits for the worktree; the next one does not.
      whenWorkspaceReady: () => (++waits === 1 ? workspace.promise : Promise.resolve()),
      wrapThreads: (threads) => ({
        ...threads,
        async update(id, patch, guard) {
          // The cleanup's status write, held until a new turn has started underneath it.
          if (held || patch.status !== "interrupted" || Object.keys(patch).length !== 1) return threads.update(id, patch, guard);
          held = true;
          arrived.resolve();
          await release.promise;
          return threads.update(id, patch, guard).then(
            (record) => {
              cleanup = "wrote";
              return record;
            },
            (error: unknown) => {
              cleanup = "refused";
              throw error;
            },
          );
        },
      }),
    });
    await h.queue.append(h.thread.id, "排队的一句", "queue");

    const dispatching = h.runs.dispatchQueue(h.thread.id);
    await startWaiting(h);
    const stopping = h.runs.stop(h.thread.id);
    await arrived.promise;
    await h.runs.start(h.thread.id, [userMessage("u2", "新的一轮")]);
    await waitFor("the new turn is streaming", () => h.engine.prompts.length === 1);
    expect((await h.threads.get(h.thread.id))?.status).toBe("running");
    release.resolve();
    await waitFor("the cleanup's write is over", () => cleanup != null);

    // The stop was pressed before this turn began: its cleanup does not mark it.
    expect(cleanup).toBe("refused");
    await within(stopping);
    await within(dispatching);
    workspace.resolve();
  });

  it("排队消息的启动被停止：消息连同附件放回队列，任务停在 interrupted，之后「发送」照常", async () => {
    const workspace = deferred();
    const h = await harness({ whenWorkspaceReady: () => workspace.promise });
    await h.queue.append(h.thread.id, "排队的一句", "queue", [picture]);

    const dispatching = h.runs.dispatchQueue(h.thread.id);
    await startWaiting(h);
    await within(h.runs.stop(h.thread.id));
    await within(dispatching);

    const paused = await h.threads.get(h.thread.id);
    expect(paused?.status).toBe("interrupted");
    expect(paused?.queue).toHaveLength(1);
    expect(paused?.queue?.[0]).toMatchObject({ text: "排队的一句", files: [picture] });
    expect(paused?.queue?.[0]?.accepted).toBeFalsy();

    workspace.resolve();
    await sleep(50);
    expect(h.engine.created).toHaveLength(0);
    // A nudge does not send it: the queue is paused, as after any 停止.
    await h.runs.dispatchQueue(h.thread.id);
    await sleep(30);
    expect(h.engine.created).toHaveLength(0);

    // 「发送」 does.
    await h.runs.sendQueued(h.thread.id, paused!.queue![0]!.id);
    await slotFree(h);
    expect(h.engine.prompts).toHaveLength(1);
    expect(h.engine.prompts[0]).toContain("排队的一句");
    expect((await h.threads.get(h.thread.id))?.queue ?? []).toHaveLength(0);
  });
});

// --- 关服务 ---------------------------------------------------------------------------

describe("关服务时还在启动路上的回合", () => {
  it.each([false, true])("不等它（recoverRunning: %s）：当场取消，消息回到队列，下次启动照常发出", async (recoverRunning) => {
    const h = await harness({ whenWorkspaceReady: () => new Promise<void>(() => {}) });
    const sent: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "第一句" }, picture] };
    const outcome = outcomeOf(h.runs.start(h.thread.id, [sent]));
    await startWaiting(h);

    // A setup that never finishes no longer holds the quit.
    await within(h.runs.stopAll({ recoverRunning }));
    const error = await within(outcome);
    expect(error).toBeInstanceOf(TurnStartCancelledError);
    expect(error).toMatchObject({ status: 409, code: "server_stopping" });
    expect(h.engine.created).toHaveLength(0);
    const record = await h.threads.get(h.thread.id);
    expect(record).toMatchObject({ status: "idle", messages: [] });
    expect(record?.queue).toEqual([expect.objectContaining({ id: "u1", text: "第一句", mode: "queue", files: [picture] })]);

    // The next launch: the same tasks, a new manager, and the message goes out.
    const next = await harness({ dir: h.dir });
    await next.runs.dispatchQueue(h.thread.id);
    await slotFree(next);
    expect(next.engine.prompts).toHaveLength(1);
    expect(next.engine.prompts[0]).toContain("第一句");
    const after = await next.threads.get(h.thread.id);
    expect(after?.queue ?? []).toEqual([]);
    expect(after?.messages.filter((message) => message.role === "user").map((message) => message.id)).toEqual(["u1"]);
    expect(after?.messages[0]?.parts).toContainEqual(expect.objectContaining({ type: "file", filename: "a.png" }));
  });

  it("排队消息的启动：放回队列，任务不停在 interrupted，下次启动照常发出", async () => {
    const h = await harness({ whenWorkspaceReady: () => new Promise<void>(() => {}) });
    await h.queue.append(h.thread.id, "排队的一句", "queue");
    const dispatching = h.runs.dispatchQueue(h.thread.id);
    await startWaiting(h);

    await within(h.runs.stopAll());
    await within(dispatching);
    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("idle");
    expect(record?.queue).toEqual([expect.objectContaining({ text: "排队的一句" })]);
    expect(record?.queue?.[0]?.claimed).toBeFalsy();

    const next = await harness({ dir: h.dir });
    await next.runs.dispatchQueue(h.thread.id);
    await slotFree(next);
    expect(next.engine.prompts).toEqual(["排队的一句"]);
  });

  it("追问在等上一轮收尾：上一轮照完整结束记下，追问回到队列，下次启动发出", async () => {
    const counting = deferred();
    const release = deferred();
    const h = await harness({
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return undefined;
      },
    });
    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "干活")]));
    await counting.promise;
    const history = (await h.threads.get(h.thread.id))!.messages;
    const followUp = outcomeOf(h.runs.start(h.thread.id, [...history, userMessage("u2", "追问")]));
    await startWaiting(h);

    const stopping = h.runs.stopAll();
    expect(await within(followUp)).toBeInstanceOf(TurnStartCancelledError);
    await sleep(100); // the shutdown has reached the turn by now
    release.resolve();
    await within(stopping);

    const record = await h.threads.get(h.thread.id);
    expect(turnEndOf(record, "u1")).toBeUndefined();
    expect(record?.status).toBe("idle");
    expect(record?.queue).toEqual([expect.objectContaining({ id: "u2", text: "追问" })]);
  });
});

// --- 停止与上一轮 ----------------------------------------------------------------------

describe("停止落在新回合和上一轮之间", () => {
  it("挂在审批上的任务发了新提问、回合刚开写就被停止：审批卡关掉，新回合的收尾不会把它重新打开", async () => {
    const saving = deferred();
    const release = deferred();
    let held = false;
    const h = await harness({
      behavior: (script) => (script.text.includes("用工具") ? askApproval(script) : untilAborted(script)),
      wrapThreads: (threads) => ({
        ...threads,
        async saveMessages(id, messages) {
          // The new turn's first write of its own: it is registered, and holds the history it started from.
          if (!held && JSON.stringify(messages).includes("新问题")) {
            held = true;
            saving.resolve();
            await release.promise;
          }
          return threads.saveMessages(id, messages);
        },
      }),
    });

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "用工具")]));
    await slotFree(h);
    expect(h.runs.stats().parked).toBe(1);

    const parkedHistory = (await h.threads.get(h.thread.id))!.messages;
    const hub = await h.runs.start(h.thread.id, [...parkedHistory, userMessage("u2", "新问题")]);
    await saving.promise;
    const stopping = h.runs.stop(h.thread.id);
    await waitFor("the parked engine is released", () => h.engine.destroyed.includes(1));
    release.resolve();
    await within(stopping);
    await within(drain(hub));
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    // Nothing left for the client to offer approve / deny on.
    const tools = record!.messages.flatMap((message) => message.parts.filter(isToolUIPart));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ state: "output-error" });
    await expectIdle(h);
  });

  it("追问在等上一轮收尾时点停止：只取消追问，上一轮照完整结束记下（计划照存），排队原地不动", async () => {
    const counting = deferred();
    const release = deferred();
    const plans: string[] = [];
    const h = await harness({
      mode: "plan",
      behavior: answer("完整的计划"),
      savePlan: async (_threadId, content) => {
        plans.push(content);
      },
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return undefined;
      },
    });
    await h.queue.append(h.thread.id, "排队的下一条", "queue");

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "出个计划")]));
    await counting.promise; // the answer is complete; the diff is being counted
    const history = (await h.threads.get(h.thread.id))!.messages;
    const followUp = outcomeOf(h.runs.start(h.thread.id, [...history, userMessage("u2", "追问")]));
    await startWaiting(h);
    const stopping = h.runs.stop(h.thread.id);
    expect(await within(followUp)).toBeInstanceOf(TurnStartCancelledError);
    await sleep(100); // the stop has reached the turn by now
    release.resolve();
    await within(stopping);
    await slotFree(h);
    await sleep(100); // room for a dispatcher that must not fire

    const record = await h.threads.get(h.thread.id);
    // The user's own stop: the task is not 未读, as after any stop.
    expect(record?.unread).toBeUndefined();
    // The turn that had answered in full is recorded as such...
    const metadata = record?.messages.find((message) => message.id === "u1")?.metadata as ThreadMessageMetadata;
    expect(metadata.turnEnd).toBeUndefined();
    expect(metadata.run?.stopReason).not.toBe("cancelled");
    expect(plans).toEqual(["完整的计划"]);
    expect(record?.messages.some((message) => message.id === "u2")).toBe(false);
    // ...and the stop still holds the queue, as every stop does.
    expect(record?.status).toBe("interrupted");
    expect(record?.queue).toHaveLength(1);
    expect(h.engine.prompts).toEqual(["出个计划"]);
  });

  it("上一轮收尾时「发送」一条排队消息又点停止：消息回到队列，上一轮照完整结束记下，不会被自动发出", async () => {
    const counting = deferred();
    const release = deferred();
    const h = await harness({
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return undefined;
      },
    });
    const queued = (await h.queue.append(h.thread.id, "排队的一句", "queue")).queue![0]!;

    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "干活")]));
    await counting.promise;
    const sending = outcomeOf(h.runs.sendQueued(h.thread.id, queued.id));
    await startWaiting(h);
    const stopping = h.runs.stop(h.thread.id);
    expect(await within(sending)).toBeInstanceOf(TurnStartCancelledError);
    await sleep(100); // the stop has reached the turn by now
    release.resolve();
    await within(stopping);
    await slotFree(h);
    await sleep(100);

    const record = await h.threads.get(h.thread.id);
    expect(turnEndOf(record, "u1")).toBeUndefined();
    expect(record?.status).toBe("interrupted");
    expect(record?.queue).toEqual([expect.objectContaining({ id: queued.id, text: "排队的一句" })]);
    expect(record?.queue?.[0]?.claimed).toBeFalsy();
    expect(record?.queue?.[0]?.accepted).toBeFalsy();
    expect(h.engine.prompts).toEqual(["干活"]);
  });

  it("上一轮收尾后却停在了审批上：那不算完整结束，停止照样把它停掉", async () => {
    const counting = deferred();
    const release = deferred();
    const h = await harness({
      behavior: askApproval,
      changeStats: async () => {
        counting.resolve();
        await release.promise;
        return undefined;
      },
    });
    await drain(await h.runs.start(h.thread.id, [userMessage("u1", "用工具")]));
    await counting.promise;
    const history = (await h.threads.get(h.thread.id))!.messages;
    const followUp = outcomeOf(h.runs.start(h.thread.id, [...history, userMessage("u2", "别管了，换个事")]));
    await startWaiting(h);
    const stopping = h.runs.stop(h.thread.id);
    expect(await within(followUp)).toBeInstanceOf(TurnStartCancelledError);
    release.resolve();
    await within(stopping);
    await slotFree(h);

    const record = await h.threads.get(h.thread.id);
    expect(record?.status).toBe("interrupted");
    const tool = record?.messages.flatMap((message) => message.parts.filter(isToolUIPart))[0];
    expect(tool).toMatchObject({ state: "output-error", errorText: STOP_INTERRUPT_TEXT });
    await expectIdle(h);
  });
});

// --- 存储 -------------------------------------------------------------------------------

describe("线程存储和队列存储", () => {
  it("串行链：一有空就撤掉，出错的调用也不留，顺序照旧", async () => {
    const dir = await tempDir();
    const threads = createThreadStore(dir);
    const queue = createQueueStore(threads);
    const first = await threads.create({ projectId: "p", engine: "vgent" });
    const second = await threads.create({ projectId: "p", engine: "vgent" });

    await threads.update(first.id, { title: "一" });
    await threads.saveMessages(second.id, [userMessage("m1", "hi")]);
    await threads.saveHarnessState(first.id, { version: 1, sessionId: first.id, updatedAt: new Date().toISOString() } as HarnessState);
    await queue.append(first.id, "排一条");
    await queue.append(second.id, "再排一条");
    const item = (await threads.get(first.id))!.queue![0]!;
    await queue.remove(first.id, item.id);
    await expect(queue.remove(first.id, "不存在")).rejects.toMatchObject({ code: "queue_item_not_found" });
    await expect(threads.update("missing", { title: "x" })).rejects.toBeDefined();
    await threads.remove(second.id);
    await sleep(20);
    expect(threads.stats()).toEqual({ chains: 0 });
    expect(queue.stats()).toEqual({ chains: 0 });

    // Calls that overlap still run one after the other, in the order they were made...
    await Promise.all(Array.from({ length: 10 }, (_, index) => threads.update(first.id, { title: `第 ${index} 次` })));
    expect((await threads.get(first.id))?.title).toBe("第 9 次");
    await Promise.all(Array.from({ length: 5 }, (_, index) => queue.append(first.id, `排 ${index}`)));
    expect((await threads.get(first.id))?.queue?.map((entry) => entry.text)).toEqual(["排 0", "排 1", "排 2", "排 3", "排 4"]);
    // ...and the chains are gone again once they have.
    await sleep(20);
    expect(threads.stats()).toEqual({ chains: 0 });
    expect(queue.stats()).toEqual({ chains: 0 });
  });

  it("写入可以带前提：状态已不是那个就拒绝（409 thread_changed），一个字不写", async () => {
    const dir = await tempDir();
    const threads = createThreadStore(dir);
    const record = await threads.create({ projectId: "p", engine: "vgent" });
    await threads.update(record.id, { status: "running" });

    await expect(threads.update(record.id, { status: "interrupted", title: "不该写" }, { status: "idle" })).rejects.toMatchObject({
      status: 409,
      code: "thread_changed",
    });
    expect(await threads.get(record.id)).toMatchObject({ status: "running", title: record.title });

    await threads.update(record.id, { status: "interrupted" }, { status: "running" });
    expect((await threads.get(record.id))?.status).toBe("interrupted");
  });
});

// --- 压缩与回合 ------------------------------------------------------------------------

describe("后台压缩占着任务的时候", () => {
  it("管理器层：有回合在跑、在启动路上、挂在审批上，或已在压缩，都不能压；占着时新回合被拒、排队不发，放开才发", async () => {
    const h = await harness();
    const release = h.runs.claimCompaction(h.thread.id);
    expect(thrown(() => h.runs.claimCompaction(h.thread.id))).toMatchObject({ status: 409, code: "compact_running" });

    await expect(h.runs.start(h.thread.id, [userMessage("u1", "压缩中")])).rejects.toMatchObject({ status: 409, code: "thread_compacting" });
    await h.queue.append(h.thread.id, "压缩时排的队", "queue");
    // The dispatcher leaves the queue alone: not even taken out and put back.
    const take = vi.spyOn(h.queue, "take");
    await h.runs.dispatchQueue(h.thread.id);
    expect(take).not.toHaveBeenCalled();
    take.mockRestore();
    expect(h.engine.created).toHaveLength(0);

    release();
    await h.runs.dispatchQueue(h.thread.id);
    await slotFree(h);
    expect(h.engine.prompts).toEqual(["压缩时排的队"]);

    // A start on its way — waiting for the worktree, say — read the history
    // before any summary existed: refused for, not raced.
    const starting = await harness({ whenWorkspaceReady: () => new Promise<void>(() => {}) });
    const outcome = outcomeOf(starting.runs.start(starting.thread.id, [userMessage("u1", "第一句")]));
    await startWaiting(starting);
    expect(thrown(() => starting.runs.claimCompaction(starting.thread.id))).toMatchObject({ status: 409, code: "thread_running" });
    await starting.runs.stop(starting.thread.id);
    expect(await within(outcome)).toBeInstanceOf(TurnStartCancelledError);

    // A live turn refuses it, and so does one only finishing its bookkeeping...
    const live = await harness({ behavior: untilAborted });
    await live.runs.start(live.thread.id, [userMessage("u1", "慢活")]);
    expect(thrown(() => live.runs.claimCompaction(live.thread.id))).toMatchObject({ status: 409, code: "thread_running" });
    // ...and so does one parked on an approval.
    const parked = await harness({ behavior: askApproval });
    await drain(await parked.runs.start(parked.thread.id, [userMessage("u1", "用工具")]));
    await slotFree(parked);
    expect(thrown(() => parked.runs.claimCompaction(parked.thread.id))).toMatchObject({ status: 409, code: "compact_pending" });
  });

  it("自动继续等压缩：不起引擎、不记错误、意图留着，压完再续", async () => {
    const h = await harness();
    await h.threads.update(h.thread.id, {
      status: "interrupted",
      restartRecovery: "recovery-1",
      messages: [userMessage("u0", "原来的活"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "做到一半" }] }],
    });

    const release = h.runs.claimCompaction(h.thread.id);
    await h.runs.resumeInterrupted(h.thread.id);
    // The record can still say 压缩中 once the claim is gone, until the summary lands.
    release();
    await h.threads.update(h.thread.id, { compaction: { startedAt: new Date().toISOString() } });
    await h.runs.resumeInterrupted(h.thread.id);
    expect(h.engine.created).toHaveLength(0);
    let record = await h.threads.get(h.thread.id);
    expect(record?.restartRecovery).toBe("recovery-1");
    expect(record?.error).toBeUndefined();

    await h.threads.update(h.thread.id, { compaction: undefined });
    await h.runs.resumeInterrupted(h.thread.id);
    await slotFree(h);
    expect(h.engine.prompts).toHaveLength(1);
    record = await h.threads.get(h.thread.id);
    expect(record?.restartRecovery).toBeUndefined();
    expect(record?.status).toBe("idle");
  });

  it("HTTP：回合在启动路上不能压；压缩中发消息被挡住；压完摘要留着", async () => {
    const dir = await tempDir();
    const summary = heldSummariser();
    const probe = { held: true, entered: deferred() };
    const engine = createEngine();
    const app = makeApp(dir, statelessVgent(engine.factory, async () => {
      if (!probe.held) return;
      probe.entered.resolve();
      await new Promise<void>(() => {});
    }), { compactModel: summary.model });
    const { thread } = await setupThread(app, dir, "vgent");
    await createThreadStore(dir).update(thread.id, { messages: history });

    const chat = postJson(app, `/api/chat/${thread.id}`, { messages: [...history, userMessage("m4", "启动路上的")] });
    await probe.entered.promise;
    const refused = await postJson(app, `/api/threads/${thread.id}/compact`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "thread_running" } });
    expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);
    expect((await within(chat)).status).toBe(409);
    probe.held = false;

    expect((await postJson(app, `/api/threads/${thread.id}/compact`, {})).status).toBe(202);
    const sent = await postJson(app, `/api/chat/${thread.id}`, { messages: [...history, userMessage("m5", "压缩中途发的")] });
    expect(sent.status).toBe(409);
    expect(await sent.json()).toMatchObject({ error: { code: "thread_compacting" } });

    summary.release();
    const record = await settledCompaction(dir, thread.id);
    expect(record.messages.map((message) => message.id).slice(0, 3)).toEqual(["m1", "m2", "m3"]);
    expect(record.messages).toHaveLength(4);
    expect((record.messages[3]!.metadata as ThreadMessageMetadata).compacted).toBeDefined();
    expect(record.status).toBe("idle");
    expect(engine.created).toHaveLength(0);
  });

  it("HTTP：压缩时等着的自动继续，压完就续上", async () => {
    const dir = await tempDir();
    const summary = heldSummariser();
    const engine = createEngine();
    const app = makeApp(dir, statelessVgent(engine.factory), { compactModel: summary.model });
    const { thread } = await setupThread(app, dir, "vgent");
    await sleep(100); // the boot's own 自动继续 pass is over
    await createThreadStore(dir).update(thread.id, { status: "interrupted", restartRecovery: "recovery-1", messages: history });

    expect((await postJson(app, `/api/threads/${thread.id}/compact`, {})).status).toBe(202);
    await sleep(50);
    expect(engine.created).toHaveLength(0);
    summary.release();

    await waitFor("the interrupted task is picked up again", () => engine.prompts.length === 1);
    expect(engine.prompts[0]).toContain(RESTART_RESUME_TEXT);
    await waitFor("it settles", async () => (await getThread(app, thread.id)).status === "idle");
    const record = await getThread(app, thread.id);
    expect(record.restartRecovery).toBeUndefined();
    expect(record.messages.some((message) => (message.metadata as ThreadMessageMetadata | undefined)?.compacted != null)).toBe(true);
  });
});

// --- 回收 worktree 的守卫 -----------------------------------------------------------

describe.skipIf(!hasGit)("回收 worktree", () => {
  it("等审批 / 等回答的任务不能回收，空闲的可以", async () => {
    const dir = await tempDir();
    const repo = await gitRepo();
    const app = makeApp(dir, createEngine().factory);
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (await postJson(app, "/api/threads", { projectId: project.id, engine: "claude-code", workspace: "worktree" })).json()) as ThreadRecord;
    const path = thread.workspace?.path ?? "";
    expect(path).not.toBe("");
    const store = createThreadStore(dir);

    for (const status of ["awaiting-approval", "awaiting-input"] as const) {
      // Parked: no run entry, but the engine is alive and standing in this directory.
      await store.update(thread.id, { status });
      const refused = await postJson(app, `/api/threads/${thread.id}/workspace/reclaim`, {});
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "thread_running" } });
      expect((await stat(path)).isDirectory()).toBe(true);
      expect((await getThread(app, thread.id)).workspace?.reclaimed).toBeUndefined();
    }

    await store.update(thread.id, { status: "idle" });
    expect((await postJson(app, `/api/threads/${thread.id}/workspace/reclaim`, {})).status).toBe(200);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// --- app helpers ---------------------------------------------------------------------

const history: UIMessage[] = [
  userMessage("m1", "把登录页改成中文"),
  { id: "m2", role: "assistant", parts: [{ type: "text", text: "改好了" }] },
  userMessage("m3", "再加个按钮"),
];

/** A summariser that answers only when told to, so a test can act while a 压缩 is in progress. */
function heldSummariser() {
  const gate = deferred();
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      await gate.promise;
      return {
        content: [{ type: "text" as const, text: "摘要内容" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  }) as unknown as LanguageModel;
  return { model, release: () => gate.resolve() };
}

/** The record once its 压缩 has settled one way or the other. */
async function settledCompaction(dataDir: string, threadId: string): Promise<ThreadRecord> {
  const store = createThreadStore(dataDir);
  let record: ThreadRecord | undefined;
  await waitFor("the 压缩 to settle", async () => {
    record = await store.get(threadId);
    return record != null && (record.compaction == null || record.compaction.error != null);
  });
  return record!;
}

/** A scripted engine standing in for the in-house one, stateless like it — its 压缩 runs in the background. */
function statelessVgent(factory: EngineFactoryOverride, ensureAvailable?: EngineFactoryOverride["ensureAvailable"]) {
  return { vgent: { ...factory, statelessTurns: true, ...(ensureAvailable != null ? { ensureAvailable } : {}) } };
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function request(app: VgentApp, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return await app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...auth, ...(init?.body != null ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
}

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });

function makeApp(
  dataDir: string,
  engines: EngineFactoryOverride | Partial<Record<"vgent" | "claude-code", EngineFactoryOverride>>,
  extra: { compactModel?: LanguageModel } = {},
): VgentApp {
  const overrides = "create" in engines ? { "claude-code": engines as EngineFactoryOverride } : engines;
  const app = createApp({
    dataDir,
    token: TOKEN,
    ...extra,
    // Fake engines and their models must not depend on the machine's real logins.
    probeClaudeLogin: async () => ({ loggedIn: true, email: "dev@example.com" }),
    accountOptions: { probeCodex: async () => ({ codex: { available: false, source: null } }) },
    downloadsDir: join(dataDir, "Downloads"),
    catalogFetch: async () => {
      throw new Error("offline in tests");
    },
    registry: createEngineRegistry(overrides),
  });
  apps.push(app);
  return app;
}

async function setupThread(app: VgentApp, repoPath: string, engine = "claude-code"): Promise<{ project: Project; thread: ThreadRecord }> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  const thread = (await (await postJson(app, "/api/threads", { projectId: project.id, title: "状态机", engine })).json()) as ThreadRecord;
  return { project, thread };
}

async function getThread(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  return (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
}

/** A repo with one commit, for the tests that need a real worktree. */
async function gitRepo(): Promise<string> {
  const repo = await tempDir();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@vgent.local"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Vgent Test"], { cwd: repo });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line1\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "初始"], { cwd: repo });
  return repo;
}
