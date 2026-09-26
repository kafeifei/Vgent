import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import type { Project, ThreadRecord } from "./types.js";

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
function createGatedEngine(
  options: {
    approvalOn?: string;
    failOn?: string;
    instant?: boolean;
    unavailable?: () => boolean;
    /** 插话: `push` takes it through `runner.steer`, `applied` also reports delivery, `pull` reads the queue once its gate opens, `refuse` has `steer` throw. */
    steer?: "push" | "applied" | "pull" | "refuse";
  } = {},
) {
  const prompts: string[] = [];
  /** Every turn's whole history as the engine was handed it: `role:text`. */
  const histories: string[][] = [];
  /** What reached the running turn, by either road. */
  const steered: string[] = [];
  const releases: Array<() => void> = [];

  const body = (
    text: string,
    gate: Promise<void>,
    aborted: () => boolean,
    takeSteers: () => Promise<string[]>,
  ): ReadableStream<TextStreamPart<ToolSet>> =>
    ReadableStream.from(
      (async function* () {
        yield { type: "start" } as TextStreamPart<ToolSet>;
        await gate;
        // An engine that owns its loop asks between steps; here, once, before it answers.
        if (options.steer === "pull") steered.push(...(await takeSteers()));
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
    async create(ctx): Promise<EngineRunner> {
      return {
        hasUnfinishedTurn: () => false,
        ...(options.steer === "push" || options.steer === "applied" || options.steer === "refuse"
          ? {
              async steer(text: string, messageId: string) {
                if (options.steer === "refuse") throw new Error("这一轮已经结束");
                steered.push(text);
                if (options.steer === "applied") await ctx.steerApplied(messageId);
              },
            }
          : {}),
        async stream({ messages, abortSignal }) {
          const text = textOf(messages.at(-1));
          prompts.push(text);
          histories.push(messages.map((message) => `${message.role}:${textOf(message)}`));
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          releases.push(release);
          if (options.instant === true) release();
          return { stream: body(text, gate, () => abortSignal.aborted, ctx.takeSteers) };
        },
        async finish() {},
        async destroy() {},
      };
    },
  };

  return {
    factory,
    prompts,
    histories,
    steered,
    /** Waits until `count` turns have started, then lets the oldest unreleased one finish. */
    async releaseTurn(count: number): Promise<void> {
      await waitFor(`第 ${count} 轮开始`, () => prompts.length >= count);
      releases[count - 1]?.();
    },
  };
}

/** The 插话 texts inside a stored assistant message, in order. */
const steersIn = (message: UIMessage | undefined): string[] =>
  (message?.parts ?? []).flatMap((part) => (part.type === "data-steer" ? [(part as { data: { text: string } }).data.text] : []));


describe.skipIf(!hasGit)("follow-up delivery regressions", () => {
  it("uses the queue message identity in the transcript", async () => {
    const engine = createGatedEngine({ steer: "push" });
    const app = makeApp(await tempDir(), engine.factory);
    const thread = await setupThread(app, await repoWithHistory());
    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "original")] });
    await waitFor("started", () => engine.prompts.length === 1);
    const record = await (await postJson(app, `/api/threads/${thread.id}/queue`, { text: "guidance" })).json() as ThreadRecord;
    const itemId = record.queue![0]!.id;
    await engine.releaseTurn(1);
    await (await first).text();
    await waitForStatus(app, thread.id, "idle");
    const part = (await getThread(app, thread.id)).messages.flatMap(m => m.parts).find(p => p.type === "data-steer");
    expect(part).toMatchObject({ id: itemId, data: { messageId: itemId } });
  });
  it("does not allow deleting a steer while it is being delivered", async () => {
    const engine = createGatedEngine({ steer: "push" });
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>(r => { release = r; });
    const factory: EngineFactoryOverride = { async create(ctx) {
      const runner = await engine.factory.create(ctx);
      return { ...runner, async steer(text, messageId) {
        entered = true;
        await gate;
        await runner.steer!(text, messageId);
      } };
    }};
    const app = makeApp(await tempDir(), factory);
    const thread = await setupThread(app, await repoWithHistory());
    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "original")] });
    await waitFor("started", () => engine.prompts.length === 1);
    const sending = postJson(app, `/api/threads/${thread.id}/queue`, { text: "guidance" });
    await waitFor("delivering", () => entered);
    const item = (await getThread(app, thread.id)).queue![0]!;
    const deleting = await request(app, `/api/threads/${thread.id}/queue/${item.id}`, { method: "DELETE" });
    release();
    await sending;
    await engine.releaseTurn(1);
    await (await first).text();
    expect(deleting.status).toBe(409);
  });
  it("never requeues a steer the runtime already applied when stopped", async () => {
    const engine = createGatedEngine({ steer: "applied" });
    const app = makeApp(await tempDir(), engine.factory);
    const thread = await setupThread(app, await repoWithHistory());
    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "original")] });
    await waitFor("started", () => engine.prompts.length === 1);
    await postJson(app, `/api/threads/${thread.id}/queue`, { text: "guidance" });
    await postJson(app, `/api/chat/${thread.id}/stop`, {});
    await (await first).text();
    const record = await getThread(app, thread.id);
    expect(record.queue ?? []).toHaveLength(0);
    expect(record.messages.flatMap(steersIn)).toEqual(["guidance"]);
  });
});

it("late cleanup from a stopped turn must not erase the newer live turn", async () => {
  const releases: Array<() => void> = [];
  const engine: EngineFactoryOverride = { async create() { return {
    hasUnfinishedTurn: () => false, async finish() {}, async destroy() {},
    async stream() { return { stream: new ReadableStream<TextStreamPart<ToolSet>>({ start(controller) {
      controller.enqueue({type:"start"});
      releases.push(() => controller.close());
    } }) }; }
  }; } };
  const app = createApp({ dataDir: await tempDir(), token:TOKEN, stopTimeoutMs: 50, registry:createEngineRegistry({"claude-code":engine}) });
  apps.push(app);
  const thread = await setupThread(app, await repoWithHistory());
  const first = postJson(app, `/api/chat/${thread.id}`, { messages:[userMessage("u1", "first")] });
  await waitFor("first", () => releases.length === 1);
  await postJson(app, `/api/chat/${thread.id}/stop`, {});
  const second = postJson(app, `/api/chat/${thread.id}`, { messages:[userMessage("u2", "second")] });
  await waitFor("second", () => releases.length === 2);
  releases[0]!();
  await (await first).text();
  // Allow the old turn's bookkeeping and snapshot to finish.
  await sleep(150);
  const streamStatus = (await request(app, `/api/chat/${thread.id}/stream`)).status;
  const record = await getThread(app, thread.id);
  releases[1]!();
  await (await second).text();
  expect.soft(streamStatus).toBe(200);
  expect.soft(record.messages.some(m => m.id === "u2")).toBe(true);
});

it("a delayed steer acknowledgement must not erase the message from queue and history", async () => {
  const engine = createGatedEngine({ steer:"push" });
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(r => { release = r; });
  const factory: EngineFactoryOverride = { async create(ctx) {
    const runner = await engine.factory.create(ctx);
    return { ...runner, async steer(text, messageId) {
      entered = true;
      await gate;
      await runner.steer!(text, messageId);
    } };
  }};
  const app = makeApp(await tempDir(), factory);
  const thread = await setupThread(app, await repoWithHistory());
  const first = postJson(app, `/api/chat/${thread.id}`, { messages:[userMessage("u1", "original")] });
  await waitFor("started", () => engine.prompts.length === 1);
  const sending = postJson(app, `/api/threads/${thread.id}/queue`, { text:"late guidance" });
  await waitFor("delivering", () => entered);
  await engine.releaseTurn(1);
  await (await first).text();
  await waitForStatus(app, thread.id, "idle");
  release();
  await sending;
  await waitFor("receipt cleanup", async () => !(await getThread(app,thread.id)).queue?.some(item => item.accepted));
  const record = await getThread(app,thread.id);
  const retained = [...(record.queue ?? []).map(item => item.text), ...record.messages.flatMap(steersIn)];
  expect(retained).toContain("late guidance");
});

it("does not resend if the runtime starts the steer while the manual interrupt is waiting", async () => {
  const engine = createGatedEngine({ steer: "push" });
  let messageId: string | undefined;
  const factory: EngineFactoryOverride = { async create(ctx) {
    const runner = await engine.factory.create(ctx);
    return { ...runner,
      hasUnfinishedTurn: () => true,
      async steer(text, id) { messageId = id; await runner.steer!(text, id); },
      async destroy() { if (messageId) await ctx.steerApplied(messageId); },
    };
  } };
  const app = makeApp(await tempDir(), factory);
  const thread = await setupThread(app, await repoWithHistory());
  const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "original")] });
  await waitFor("started", () => engine.prompts.length === 1);
  await postJson(app, `/api/threads/${thread.id}/queue`, { text: "guide" });
  const sent = await postJson(app, `/api/threads/${thread.id}/queue/${messageId}/send`, { interrupt: true });
  await (await first).text();
  expect(sent.status).toBe(409);
  expect(engine.prompts).toEqual(["original"]);
  expect((await getThread(app, thread.id)).queue ?? []).toHaveLength(0);
});

it("reserves a manual interrupt against double clicks and sends one user message", async () => {
  const engine = createGatedEngine({ steer: "push" });
  let destroying = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const factory: EngineFactoryOverride = { async create(ctx) {
    const runner = await engine.factory.create(ctx);
    return { ...runner, hasUnfinishedTurn: () => true,
      async destroy() { destroying = true; await gate; },
    };
  } };
  const app = makeApp(await tempDir(), factory);
  const thread = await setupThread(app, await repoWithHistory());
  const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "original")] });
  await waitFor("started", () => engine.prompts.length === 1);
  const record = await (await postJson(app, `/api/threads/${thread.id}/queue`, { text: "guide" })).json() as ThreadRecord;
  const id = record.queue![0]!.id;
  const send = postJson(app, `/api/threads/${thread.id}/queue/${id}/send`, { interrupt: true });
  await waitFor("old engine cleanup", () => destroying);
  const duplicate = await postJson(app, `/api/threads/${thread.id}/queue/${id}/send`, { interrupt: true });
  release();
  expect(duplicate.status).toBe(409);
  expect((await send).status).toBe(200);
  await (await first).text();
  await engine.releaseTurn(2);
  await waitForStatus(app, thread.id, "idle");
  expect(engine.prompts).toEqual(["original", "guide"]);
  expect(engine.histories[1]!.filter(message => message === "user:guide")).toHaveLength(1);
});
