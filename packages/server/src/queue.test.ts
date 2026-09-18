import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import { QUEUE_ITEM_MAX_BYTES, QUEUE_MAX_ITEMS } from "./queue.js";
import type { Project, ThreadMessageMetadata, ThreadRecord } from "./types.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7414";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-queue-"));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** A one-commit repo, so every turn can take a real 每回合快照. */
async function repoWithHistory(): Promise<string> {
  const repo = await tempDir();
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@vgent.local");
  await git(repo, "config", "user.name", "Vgent Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "tracked.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "初始");
  return repo;
}

const auth = { authorization: `Bearer ${TOKEN}` };

function request(app: VgentApp, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...auth, ...(init?.body != null ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
}

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });
const patchJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "PATCH", body: JSON.stringify(body) });

function makeApp(dataDir: string, factory: EngineFactoryOverride): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN, registry: createEngineRegistry({ "claude-code": factory }) });
  apps.push(instance);
  return instance;
}

async function setupThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  return (await (
    await postJson(app, "/api/threads", { projectId: project.id, title: "排队", engine: "claude-code" })
  ).json()) as ThreadRecord;
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function getThread(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  return (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`等待超时: ${what}`);
}

const waitForStatus = (app: VgentApp, threadId: string, wanted: string): Promise<void> =>
  waitFor(`线程 ${threadId} 进入 ${wanted}`, async () => (await getThread(app, threadId)).status === wanted);

/**
 * A thread whose last turn failed. Queueing onto an *idle* thread just runs the
 * message — there is nothing to wait for — so every test about the queue as
 * storage parks the thread in a status that holds it instead.
 */
async function failedThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
  const thread = await setupThread(app, repoPath);
  await (await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "会炸")] })).text();
  await waitForStatus(app, thread.id, "error");
  return thread;
}

/**
 * Rewrite a thread record on disk, the way a previous process would have left
 * it, and drop the index so the next boot rebuilds it from the records.
 */
async function seedRecord(dataDir: string, threadId: string, patch: Partial<ThreadRecord>): Promise<void> {
  const path = join(dataDir, "threads", `${threadId}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as ThreadRecord;
  await writeFile(path, JSON.stringify({ ...record, ...patch }));
  await rm(join(dataDir, "threads", "index.json"), { force: true });
}

/** The text of a `ModelMessage`, however its content is shaped. */
function textOf(message: ModelMessage | undefined): string {
  if (message == null) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/**
 * A runner whose every turn hangs until the test releases it, so a queue can be
 * built up while one is demonstrably still running. `prompts` is the text of
 * the last message each turn was started with — the whole point of the queue is
 * which message ran, and when.
 */
function createGatedEngine(options: { approvalOn?: string; failOn?: string; instant?: boolean; unavailable?: () => boolean } = {}) {
  const prompts: string[] = [];
  const releases: Array<() => void> = [];

  const body = (text: string, gate: Promise<void>, aborted: () => boolean): ReadableStream<TextStreamPart<ToolSet>> =>
    ReadableStream.from(
      (async function* () {
        yield { type: "start" } as TextStreamPart<ToolSet>;
        await gate;
        // A real engine stops when its turn is aborted; this one has to too, or
        // `stop()` would sit out its whole timeout waiting for the gate.
        if (aborted()) return;
        if (options.failOn != null && text.includes(options.failOn)) throw new Error("引擎炸了");
        if (options.approvalOn != null && text.includes(options.approvalOn)) {
          const call = {
            type: "tool-call" as const,
            toolCallId: `call-${prompts.length}`,
            toolName: "bash",
            input: { command: "echo hi" },
            providerExecuted: true,
          };
          yield call as unknown as TextStreamPart<ToolSet>;
          yield { type: "tool-approval-request", approvalId: `ap-${prompts.length}`, toolCall: call } as unknown as TextStreamPart<ToolSet>;
          return;
        }
        yield { type: "text-start", id: "t1" } as TextStreamPart<ToolSet>;
        yield { type: "text-delta", id: "t1", text: "好的" } as TextStreamPart<ToolSet>;
        yield { type: "text-end", id: "t1" } as TextStreamPart<ToolSet>;
      })(),
    ) as ReadableStream<TextStreamPart<ToolSet>>;

  const factory: EngineFactoryOverride = {
    ...(options.unavailable != null
      ? {
          ensureAvailable() {
            if (options.unavailable?.() === true) throw new Error("引擎不可用");
          },
        }
      : {}),
    async create(): Promise<EngineRunner> {
      return {
        hasUnfinishedTurn: () => false,
        async stream({ messages, abortSignal }) {
          const text = textOf(messages.at(-1));
          prompts.push(text);
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          releases.push(release);
          if (options.instant === true) release();
          return { stream: body(text, gate, () => abortSignal.aborted) };
        },
        async finish() {},
        async destroy() {},
      };
    },
  };

  return {
    factory,
    prompts,
    /** Waits until `count` turns have started, then lets the oldest unreleased one finish. */
    async releaseTurn(count: number): Promise<void> {
      await waitFor(`第 ${count} 轮开始`, () => prompts.length >= count);
      releases[count - 1]?.();
    },
  };
}

describe.skipIf(!hasGit)("排队", () => {
  it("运行中排两条，依次执行，各自带上自己的 checkpoint", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一条")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);

    expect((await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" })).status).toBe(200);
    const queued = (await (await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队二" })).json()) as ThreadRecord;
    expect(queued.queue?.map((item) => item.text)).toEqual(["排队一", "排队二"]);

    await engine.releaseTurn(1);
    await (await first).text();

    // The server starts both by itself: no second HTTP request is ever made.
    await engine.releaseTurn(2);
    await engine.releaseTurn(3);
    await waitFor("队列跑空", async () => ((await getThread(app, thread.id)).queue ?? []).length === 0);
    await waitForStatus(app, thread.id, "idle");

    expect(engine.prompts.map((text) => text.includes("排队一"))).toEqual([false, true, false]);
    expect(engine.prompts.filter((text) => text.endsWith("排队一"))).toHaveLength(1);
    expect(engine.prompts.filter((text) => text.endsWith("排队二"))).toHaveLength(1);

    const record = await getThread(app, thread.id);
    const users = record.messages.filter((message) => message.role === "user");
    expect(users.map((message) => (message.parts[0] as { text: string }).text)).toEqual(["第一条", "排队一", "排队二"]);
    // 每回合快照 is taken on the server-started turns exactly as on the first.
    for (const message of users) {
      expect((message.metadata as ThreadMessageMetadata | undefined)?.checkpoint?.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("停在审批上不发，处理完回到空闲才发", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine({ approvalOn: "要审批" });
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "要审批")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" });
    await engine.releaseTurn(1);
    await (await first).text();
    await waitForStatus(app, thread.id, "awaiting-approval");

    // A parked turn is not over: the queue must stay put.
    await sleep(120);
    expect(engine.prompts).toHaveLength(1);
    expect((await getThread(app, thread.id)).queue).toHaveLength(1);

    // Deny it; the turn ends idle and the queue picks up from there.
    const parked = await getThread(app, thread.id);
    const assistant = parked.messages.at(-1)!;
    const answered = {
      ...assistant,
      parts: assistant.parts.map((part) =>
        "state" in part && part.state === "approval-requested"
          ? { ...part, state: "approval-responded", approval: { ...(part as { approval: object }).approval, approved: false } }
          : part,
      ),
    } as UIMessage;
    const second = postJson(app, `/api/chat/${thread.id}`, { messages: [answered] });
    await engine.releaseTurn(2);
    await (await second).text();

    await engine.releaseTurn(3);
    await waitFor("排队消息发出", () => engine.prompts.some((text) => text.endsWith("排队一")));
    await waitFor("队列跑空", async () => ((await getThread(app, thread.id)).queue ?? []).length === 0);
  });

  it("被停止后队列原地暂停，「发送」才发出", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "慢活")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" });

    expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);
    await (await first).text();
    await waitForStatus(app, thread.id, "interrupted");

    await sleep(120);
    expect(engine.prompts).toHaveLength(1);
    const paused = await getThread(app, thread.id);
    expect(paused.queue).toHaveLength(1);

    const item = paused.queue![0]!;
    expect((await postJson(app, `/api/threads/${thread.id}/queue/${item.id}/send`, {})).status).toBe(200);
    await engine.releaseTurn(2);
    await waitFor("排队消息发出", () => engine.prompts.some((text) => text.endsWith("排队一")));
    expect((await getThread(app, thread.id)).queue ?? []).toHaveLength(0);
  });

  it("「打断并发送」：运行中不带 interrupt 是 409，带上就先停这一轮再发这条", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "慢活")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "改方向" });
    const item = (await getThread(app, thread.id)).queue![0]!;

    // Nothing jumps a running turn by accident.
    expect((await postJson(app, `/api/threads/${thread.id}/queue/${item.id}/send`, {})).status).toBe(409);
    // A stale id must not cost the user the running turn.
    expect((await postJson(app, `/api/threads/${thread.id}/queue/nope/send`, { interrupt: true })).status).toBe(404);
    expect((await getThread(app, thread.id)).status).toBe("running");

    expect((await postJson(app, `/api/threads/${thread.id}/queue/${item.id}/send`, { interrupt: true })).status).toBe(200);
    await (await first).text();
    await waitFor("排队的那条发出", () => engine.prompts.some((text) => text.endsWith("改方向")));
    expect(engine.prompts).toHaveLength(2);
    expect((await getThread(app, thread.id)).queue ?? []).toHaveLength(0);
    await engine.releaseTurn(2);
    await waitForStatus(app, thread.id, "idle");
  });

  it("出错的回合不发排队消息", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine({ failOn: "会炸" });
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "会炸")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" });
    await engine.releaseTurn(1);
    await (await first).text();
    await waitForStatus(app, thread.id, "error");

    await sleep(120);
    expect(engine.prompts).toHaveLength(1);
    expect((await getThread(app, thread.id)).queue).toHaveLength(1);
  });

  it("排队消息可以改、可以删，不存在的条目是 404", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const app = makeApp(dir, createGatedEngine({ instant: true, failOn: "会炸" }).factory);
    const thread = await failedThread(app, repo);

    const added = (await (await postJson(app, `/api/threads/${thread.id}/queue`, { text: "原文" })).json()) as ThreadRecord;
    const id = added.queue![0]!.id;

    const edited = (await (await patchJson(app, `/api/threads/${thread.id}/queue/${id}`, { text: "改过了" })).json()) as ThreadRecord;
    expect(edited.queue?.map((item) => item.text)).toEqual(["改过了"]);

    const removed = (await (await request(app, `/api/threads/${thread.id}/queue/${id}`, { method: "DELETE" })).json()) as ThreadRecord;
    // An empty queue is stored as no queue at all.
    expect(removed.queue).toBeUndefined();

    expect((await patchJson(app, `/api/threads/${thread.id}/queue/${id}`, { text: "还在吗" })).status).toBe(404);
    const gone = (await (await request(app, `/api/threads/${thread.id}/queue/${id}`, { method: "DELETE" })).json()) as {
      error: { code: string };
    };
    expect(gone.error.code).toBe("queue_item_not_found");
  });

  it("空白、超长和超量都是 400", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const app = makeApp(dir, createGatedEngine({ instant: true, failOn: "会炸" }).factory);
    const thread = await failedThread(app, repo);

    const blank = await postJson(app, `/api/threads/${thread.id}/queue`, { text: "   " });
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { error: { code: string } }).error.code).toBe("invalid_queue_text");

    const huge = await postJson(app, `/api/threads/${thread.id}/queue`, { text: "x".repeat(QUEUE_ITEM_MAX_BYTES + 1) });
    expect(((await huge.json()) as { error: { code: string } }).error.code).toBe("queue_item_too_large");

    // Filled to the cap on a thread whose last turn failed, so nothing sends them.
    for (let index = 0; index < QUEUE_MAX_ITEMS; index++) {
      expect((await postJson(app, `/api/threads/${thread.id}/queue`, { text: `第 ${index} 条` })).status).toBe(200);
    }
    const full = await postJson(app, `/api/threads/${thread.id}/queue`, { text: "再来一条" });
    expect(full.status).toBe(400);
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe("queue_full");
  });

  it("启动时把空闲且有排队的任务发出去，中断的不发", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const first = createGatedEngine({ instant: true });
    const app = makeApp(dir, first.factory);
    const idle = await setupThread(app, repo);
    const stopped = await setupThread(app, repo);
    await apps.splice(apps.indexOf(app), 1)[0]!.shutdown();

    // What a process that died with work waiting leaves behind: one task idle
    // with a queue, one recovered as `interrupted` with the same.
    const item = (text: string) => [{ id: `q-${text}`, text, createdAt: new Date().toISOString() }];
    await seedRecord(dir, idle.id, { status: "idle", queue: item("重启后要发") });
    await seedRecord(dir, stopped.id, { status: "interrupted", queue: item("中断的不该发") });

    const second = createGatedEngine({ instant: true });
    const rebooted = makeApp(dir, second.factory);
    await request(rebooted, "/api/threads");
    await waitFor("重启后发出", () => second.prompts.some((text) => text.endsWith("重启后要发")));
    await waitFor("队列跑空", async () => ((await getThread(rebooted, idle.id)).queue ?? []).length === 0);

    await sleep(120);
    expect(second.prompts.some((text) => text.includes("中断的不该发"))).toBe(false);
    expect((await getThread(rebooted, stopped.id)).queue).toHaveLength(1);
  });

  it("server 自己发起的回合能从 /api/chat/:id/stream 观察到", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一条")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" });
    await engine.releaseTurn(1);
    await (await first).text();

    await waitFor("第二轮开始", () => engine.prompts.length === 2);
    const stream = await request(app, `/api/chat/${thread.id}/stream`);
    expect(stream.status).toBe(200);
    await engine.releaseTurn(2);
    const chunks = (await stream.text())
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)) as { type: string });
    expect(chunks.some((chunk) => chunk.type === "start")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(true);
  });

  it("客户端的 POST 撞上调度器时拿到 409，排队的那条照样只跑一次", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一条")] });
    await waitFor("第一轮开始", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "排队一" });
    await engine.releaseTurn(1);
    await (await first).text();

    // The dispatcher won the slot; a client posting into that window is told so
    // rather than starting a second turn on the same thread.
    await waitFor("第二轮开始", () => engine.prompts.length === 2);
    const clash = await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u2", "插队")] });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { code: string } }).error.code).toBe("thread_running");

    await engine.releaseTurn(2);
    await waitForStatus(app, thread.id, "idle");
    expect(engine.prompts.filter((text) => text.endsWith("排队一"))).toHaveLength(1);
    expect((await getThread(app, thread.id)).queue ?? []).toHaveLength(0);
  });

  it("发不出去的排队消息放回队列，不会凭空消失", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    let broken = false;
    const app = makeApp(dir, createGatedEngine({ instant: true, failOn: "会炸", unavailable: () => broken }).factory);
    const thread = await failedThread(app, repo);

    const requeued = (await (await postJson(app, `/api/threads/${thread.id}/queue`, { text: "发不出去" })).json()) as ThreadRecord;
    expect(requeued.queue).toHaveLength(1);
    const item = requeued.queue![0]!;

    broken = true;
    expect((await postJson(app, `/api/threads/${thread.id}/queue/${item.id}/send`, {})).status).toBe(500);
    // Taken out to be started, and put straight back when the start failed.
    expect((await getThread(app, thread.id)).queue?.map((entry) => entry.text)).toEqual(["发不出去"]);
    expect((await getThread(app, thread.id)).queue?.[0]?.id).toBe(item.id);
  });

  it("归档的任务不发，删除任务连队列一起没", async () => {
    const dir = await tempDir();
    const repo = await repoWithHistory();
    const engine = createGatedEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, repo);

    await patchJson(app, `/api/threads/${thread.id}`, { archived: true });
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "归档了别发" });
    await sleep(120);
    expect(engine.prompts).toHaveLength(0);
    expect((await getThread(app, thread.id)).queue).toHaveLength(1);

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(app, `/api/threads/${thread.id}`)).status).toBe(404);
  });
});
