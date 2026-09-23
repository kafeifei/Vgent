import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LanguageModel, ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import type { EngineDescriptor } from "./engines/capabilities.js";
import { createEngineRegistry, type EngineContext, type EngineFactoryOverride } from "./engines/registry.js";
import { DEFAULT_VGENT_MODEL } from "./engines/vgent.js";
import { EngineUnavailableError } from "./errors.js";
import { createThreadStore, type ThreadPreCompactSnapshot } from "./store/threads.js";
import type { HarnessState, Project, Settings, ThreadMessageMetadata, ThreadRecord, ThreadSummary } from "./types.js";

const execFileAsync = promisify(execFile);

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scripted engine: streams `text` word by word, then persists a fake resume state. */
function createFakeEngine(options?: { text?: string; deltaDelayMs?: number; writes?: { path: string; text: string }[] }) {
  const created: EngineContext[] = [];
  const streamed: ModelMessage[][] = [];
  const text = options?.text ?? "你好 世界 来自 假引擎";
  const delay = options?.deltaDelayMs ?? 0;
  let turn = 0;

  const factory: EngineFactoryOverride = {
    async create(ctx) {
      created.push(ctx);
      const sessionTurn = ++turn;
      // Engines write straight to disk; this one does too, so the change stats
      // a finished turn records have something real to count.
      for (const write of options?.writes ?? []) await writeFile(join(ctx.project.repoPath, write.path), write.text);
      return {
        async stream({ messages }) {
          streamed.push(messages);
          const parts = (async function* (): AsyncGenerator<TextStreamPart<ToolSet>> {
            yield { type: "start" };
            yield { type: "text-start", id: "t1" };
            for (const word of text.split(" ")) {
              if (delay > 0) await sleep(delay);
              yield { type: "text-delta", id: "t1", text: word };
            }
            yield { type: "text-end", id: "t1" };
          })();
          return { stream: ReadableStream.from(parts) as ReadableStream<TextStreamPart<ToolSet>> };
        },
        hasUnfinishedTurn: () => false,
        async destroy() {},
        async finish() {
          await ctx.saveHarnessState({
            version: 1,
            sessionId: ctx.thread.id,
            resumeFrom: { harnessId: "fake", specificationVersion: 1, data: { turn: sessionTurn } },
            updatedAt: new Date().toISOString(),
          } as unknown as HarnessState);
        },
      };
    },
  };

  return { factory, created, streamed };
}

function makeApp(dataDir: string, factory?: EngineFactoryOverride, webDist?: string): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
    // Never the real Downloads folder.
    downloadsDir: join(dataDir, "Downloads"),
    // Claude Code's model list reads the provider catalog; tests never go to models.dev for it.
    catalogFetch: async () => {
      throw new Error("offline in tests");
    },
    ...(factory != null ? { registry: createEngineRegistry({ "claude-code": factory }) } : {}),
    ...(webDist != null ? { webDist } : {}),
  });
  apps.push(instance);
  return instance;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-app-"));
  dirs.push(dir);
  return dir;
}

/** A repo with one commit and a local git identity, for the changes routes. */
async function gitRepo(): Promise<string> {
  const repo = await tempDir();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@vgent.local"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Vgent Test"], { cwd: repo });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line1\nline2\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "初始"], { cwd: repo });
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

/** Everything an SSE UI message stream body carries, as parsed chunks. */
async function readSse(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

function textOf(chunks: unknown[]): string {
  return chunks
    .filter((chunk): chunk is { type: "text-delta"; delta: string } => (chunk as { type?: string }).type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
}

async function setupThread(app: VgentApp, repoPath: string, engine = "claude-code"): Promise<{ project: Project; thread: ThreadRecord }> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  const thread = (await (await postJson(app, "/api/threads", { projectId: project.id, title: "冒烟", engine })).json()) as ThreadRecord;
  return { project, thread };
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

/** A model that answers every `generateText` call with `text` — what `/compact` needs, any number of times. */
const summariser = (text: string): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const },
      usage: {
        inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: undefined, reasoning: undefined },
        totalTokens: undefined,
      },
      warnings: [],
    },
  }) as unknown as LanguageModel;

/** Polls the resume endpoint until a run is actually live, so the test never races the run's start. */
async function waitForLiveStream(app: VgentApp, threadId: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(app, `/api/chat/${threadId}/stream`);
    if (response.status === 200) return response;
    await response.body?.cancel();
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 没有出现可续的流`);
}

/**
 * Waits until the run has actually put a chunk on the wire. The resume endpoint
 * answers as soon as the run exists, which can be before the engine has even
 * started, so a test that wants a *streaming* run has to read one chunk.
 */
async function waitForStreamedChunk(app: VgentApp, threadId: string): Promise<void> {
  const response = await waitForLiveStream(app, threadId);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes("data: ")) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
}

/** The engine persists its resume state after the run releases its slot, so the file lags the status. */
async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await stat(path).catch(() => undefined)) return;
    await sleep(10);
  }
  throw new Error(`文件没有出现: ${path}`);
}

async function waitForStatus(app: VgentApp, threadId: string, wanted: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
    if (record.status === wanted) return record;
    await sleep(20);
  }
  throw new Error(`线程 ${threadId} 没有进入状态 ${wanted}`);
}

describe("createApp", () => {
  it("serves health without a token and rejects bad tokens and hosts", async () => {
    const app = makeApp(await tempDir());

    const health = await app.app.request(`${ORIGIN}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    expect((await app.app.request(`${ORIGIN}/api/projects`)).status).toBe(401);
    expect((await app.app.request(`${ORIGIN}/api/projects`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.app.request("http://evil.example.com/api/health")).status).toBe(403);
  });

  it("accepts the token as a query parameter on the SSE routes only", async () => {
    const dir = await tempDir();
    const app = makeApp(dir);
    const { thread } = await setupThread(app, dir);

    expect((await app.app.request(`${ORIGIN}/api/chat/${thread.id}/stream?token=${TOKEN}`)).status).toBe(204);
    expect((await app.app.request(`${ORIGIN}/api/threads?token=${TOKEN}`)).status).toBe(401);
  });

  it("streams a turn, replays it to a late subscriber, and persists the assistant message", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine({ deltaDelayMs: 25 });
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    const post = postJson(app, `/api/chat/${thread.id}`, { id: thread.id, messages: [userMessage("u1", "你好")] });

    // A second client joining mid-turn replays from chunk 0.
    const reconnect = await waitForLiveStream(app, thread.id);
    expect(reconnect.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");

    const [postChunks, reconnectChunks] = await Promise.all([readSse(await post), readSse(reconnect)]);
    expect(textOf(postChunks)).toBe("你好世界来自假引擎");
    expect(reconnectChunks).toEqual(postChunks);

    const record = await waitForStatus(app, thread.id, "idle");
    expect(record.messages).toHaveLength(2);
    expect(record.messages[1]?.role).toBe("assistant");
    expect(record.messages[1]?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "你好世界来自假引擎" }));

    // The engine's resume state landed in its own 0600 file.
    const harnessPath = join(dir, "threads", `${thread.id}.harness.json`);
    await waitForFile(harnessPath);
    expect((await stat(harnessPath)).mode & 0o777).toBe(0o600);
    // The run entry is gone with it, so a reconnect is a 204. (While the run is
    // still finalizing the hub is served instead — see runs.test.ts.)
    expect((await request(app, `/api/chat/${thread.id}/stream`)).status).toBe(204);
  });

  it("refuses a second run on a thread that is already running", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine({ deltaDelayMs: 25 });
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    const first = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] });
    await (await waitForLiveStream(app, thread.id)).body?.cancel();
    const second = await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u2", "再来")] });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { code: "thread_running" } });

    // A PATCH is refused for the same reason.
    expect((await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ title: "新" }) })).status).toBe(409);
    await readSse(await first);
    await waitForStatus(app, thread.id, "idle");
  });

  it("rejects an unknown thread and bad messages", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine();
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    expect((await postJson(app, "/api/chat/nope", { messages: [userMessage("u1", "hi")] })).status).toBe(404);
    expect((await postJson(app, `/api/chat/${thread.id}`, {})).status).toBe(400);
    expect((await postJson(app, `/api/chat/${thread.id}`, { messages: [{ role: "user" }] })).status).toBe(400);
  });

  it("stores the model the creator asked for and falls back to the default without one", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const project = (await (await postJson(app, "/api/projects", { repoPath: dir })).json()) as Project;
    await request(app, "/api/settings", {
      method: "PUT",
      body: JSON.stringify({ defaultEngine: "vgent", defaultModel: "openai/gpt-5.5" }),
    });

    const defaulted = (await (await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent" })).json()) as ThreadRecord;
    expect(defaulted.model).toBe("openai/gpt-5.5");

    const picked = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent", model: "codex-subscription:gpt-5.5" })
    ).json()) as ThreadRecord;
    expect(picked.model).toBe("codex-subscription:gpt-5.5");

    // 记住上一次选择: a task that names nothing starts on what the last one did.
    const remembered = (await (await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent" })).json()) as ThreadRecord;
    expect(remembered.model).toBe("codex-subscription:gpt-5.5");
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({ defaultEngine: "vgent", defaultModel: "codex-subscription:gpt-5.5" });

    // A model id only means something to the engine it was picked under, so
    // another engine starts on its own default instead.
    const other = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "claude-code" })
    ).json()) as ThreadRecord;
    expect(other.model).toBeUndefined();
  });

  it("round-trips the reasoning effort, clears it with null and rejects a bad one", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const project = (await (await postJson(app, "/api/projects", { repoPath: dir })).json()) as Project;

    const created = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent", reasoningEffort: "high" })
    ).json()) as ThreadRecord;
    expect(created.reasoningEffort).toBe("high");

    const raised = await request(app, `/api/threads/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ reasoningEffort: "xhigh" }),
    });
    expect(((await raised.json()) as ThreadRecord).reasoningEffort).toBe("xhigh");

    // `null` hands the level back to the engine; an absent key changes nothing.
    const cleared = await request(app, `/api/threads/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ reasoningEffort: null }),
    });
    expect(((await cleared.json()) as ThreadRecord).reasoningEffort).toBeUndefined();
    const untouched = (await (
      await request(app, `/api/threads/${created.id}`, { method: "PATCH", body: JSON.stringify({ title: "改名" }) })
    ).json()) as ThreadRecord;
    expect(untouched.title).toBe("改名");
    expect(untouched.reasoningEffort).toBeUndefined();

    for (const bad of [{ reasoningEffort: "  " }, { reasoningEffort: 3 }, { reasoningEffort: "x".repeat(33) }]) {
      const rejected = await request(app, `/api/threads/${created.id}`, { method: "PATCH", body: JSON.stringify(bad) });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "invalid_reasoning_effort" } });
    }
    const rejectedOnCreate = await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent", reasoningEffort: "" });
    expect(rejectedOnCreate.status).toBe(400);
  });

  it("serves the 引擎能力表", async () => {
    const dir = await tempDir();
    const app = makeApp(dir);
    const body = (await (await request(app, "/api/engines")).json()) as { engines: EngineDescriptor[] };
    expect(body.engines.map((entry) => entry.id)).toEqual(["codex", "claude-code", "vgent"]);
    expect(body.engines[0]).toMatchObject({ label: "Codex", capabilities: { approvals: false } });
    expect(body.engines[1]).toMatchObject({ label: "Claude Code", capabilities: { approvals: true, compact: true } });
  });

  it("takes a codex thread under any run mode — 运行模式 is global now", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const project = (await (await postJson(app, "/api/projects", { repoPath: dir })).json()) as Project;

    // 自动改文件 is the default run mode, and Codex cannot ask; the task is
    // created anyway and simply runs 全自动 — see `effectivePermission`.
    const created = await postJson(app, "/api/threads", { projectId: project.id, engine: "codex" });
    expect(created.status).toBe(200);
    expect((await created.json()) as ThreadRecord).toMatchObject({ engine: "codex" });
  });

  it("resolves the global run mode and allowlist onto the turn's engine context", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine();
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ runMode: "allow-edits" }) });
    await postJson(app, "/api/settings/allowlist", { tool: "bash" });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] }));
    await waitForStatus(app, thread.id, "idle");
    expect(fake.created.at(-1)).toMatchObject({ permissionMode: "allow-edits", alwaysAllow: ["bash"] });
  });

  it("keeps one global tool allowlist", async () => {
    const dir = await tempDir();
    const app = makeApp(dir);
    const add = (tool: unknown) => postJson(app, "/api/settings/allowlist", { tool });

    expect(((await (await add("bash")).json()) as Settings).allowlist).toEqual(["bash"]);
    expect(((await (await add(" write ")).json()) as Settings).allowlist).toEqual(["bash", "write"]);
    // Adding the same tool twice is what clicking 「一直允许」 twice looks like.
    expect(((await (await add("bash")).json()) as Settings).allowlist).toEqual(["bash", "write"]);

    for (const bad of [undefined, "", "   ", 3]) {
      expect((await add(bad)).status).toBe(400);
    }

    const removed = await request(app, "/api/settings/allowlist/bash", { method: "DELETE" });
    expect(((await removed.json()) as Settings).allowlist).toEqual(["write"]);
    // Removing what is not there is a no-op, not a 404.
    const again = await request(app, "/api/settings/allowlist/bash", { method: "DELETE" });
    expect(((await again.json()) as Settings).allowlist).toEqual(["write"]);
  });

  it("lets an empty thread change engine but locks one that already has messages", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const { thread } = await setupThread(app, dir);

    const switched = await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ engine: "vgent" }) });
    expect(switched.status).toBe(200);
    expect((await switched.json()) as ThreadRecord).toMatchObject({ engine: "vgent" });

    // Back to the wired fake engine, then run a turn so the thread has history.
    await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ engine: "claude-code" }) });
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] }));
    await waitForStatus(app, thread.id, "idle");

    const locked = await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ engine: "vgent" }) });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: { code: "engine_locked" } });
    // Re-sending the engine it already has is not a change, so it still passes.
    const unchanged = await request(app, `/api/threads/${thread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ engine: "claude-code", title: "改个标题" }),
    });
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json()) as ThreadRecord).toMatchObject({ engine: "claude-code", title: "改个标题" });
  });

  it("takes engine and model in one patch while the thread is empty", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const { thread } = await setupThread(app, dir);

    const switched = await request(app, `/api/threads/${thread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ engine: "vgent", model: "openai/gpt-5" }),
    });
    expect(switched.status).toBe(200);
    expect((await switched.json()) as ThreadRecord).toMatchObject({ engine: "vgent", model: "openai/gpt-5" });
  });

  it("turns an unavailable engine into a 503 before the run starts", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      ensureAvailable() {
        throw new EngineUnavailableError("Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）");
      },
      create() {
        throw new Error("不应该被调用");
      },
    };
    const app = makeApp(dir, factory);
    const { thread } = await setupThread(app, dir);

    const response = await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "hi")] });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "engine_unavailable", message: expect.stringContaining("Codex 未登录") as unknown as string },
    });
    // The failed precondition must not leave the thread stuck `running`.
    expect((await (await request(app, `/api/threads/${thread.id}`)).json()) as ThreadRecord).toMatchObject({ status: "idle" });
  });

  it("keeps threads across a restart and hands the saved resume state to the engine", async () => {
    const dir = await tempDir();
    const first = createFakeEngine();
    const appA = makeApp(dir, first.factory);
    const { thread } = await setupThread(appA, dir);
    await readSse(await postJson(appA, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForStatus(appA, thread.id, "idle");
    await appA.shutdown();

    const second = createFakeEngine({ text: "第二轮 回答" });
    const appB = makeApp(dir, second.factory);
    const listed = (await (await request(appB, "/api/threads")).json()) as { threads: ThreadSummary[] };
    expect(listed.threads.map((entry) => entry.id)).toContain(thread.id);
    const restored = (await (await request(appB, `/api/threads/${thread.id}`)).json()) as ThreadRecord;
    expect(restored.messages).toHaveLength(2);

    await readSse(await postJson(appB, `/api/chat/${thread.id}`, { messages: [...restored.messages, userMessage("u2", "第二轮")] }));
    await waitForStatus(appB, thread.id, "idle");

    expect(second.created[0]?.harnessState?.resumeFrom).toMatchObject({ harnessId: "fake" });
    // The whole history is handed to the engine; the harness itself picks the
    // turn's fresh user message out of it.
    expect(second.streamed[0]?.at(-1)).toMatchObject({ role: "user" });
    await waitForFile(join(dir, "threads", `${thread.id}.harness.json`));
    const harnessFile = JSON.parse(await readFile(join(dir, "threads", `${thread.id}.harness.json`), "utf8")) as HarnessState;
    expect(harnessFile.sessionId).toBe(thread.id);
  });

  it("pushes the thread list over /api/state and refreshes it after a run", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine();
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    const controller = new AbortController();
    const response = await app.app.request(`${ORIGIN}/api/state?token=${TOKEN}`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    const readEvent = async (): Promise<{ threads: ThreadSummary[] }> => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("状态流提前结束");
        buffer += decoder.decode(value, { stream: true });
        const line = buffer.split("\n").find((entry) => entry.startsWith("data: "));
        if (line != null) return JSON.parse(line.slice(6)) as { threads: ThreadSummary[] };
      }
    };

    const initial = await readEvent();
    expect(initial.threads.find((entry) => entry.id === thread.id)).toMatchObject({ status: "idle", messageCount: 0 });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] }));
    await waitForStatus(app, thread.id, "idle");
    const updated = await readEvent();
    expect(updated.threads.find((entry) => entry.id === thread.id)?.messageCount).toBeGreaterThan(0);

    await reader.cancel();
    controller.abort();
  });

  it("stops a live run and marks the thread interrupted", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine({ deltaDelayMs: 40 });
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);

    const post = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] });
    await waitForStreamedChunk(app, thread.id);
    expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);

    const chunks = await readSse(await post);
    expect(chunks.length).toBeGreaterThan(0);
    const record = (await (await request(app, `/api/threads/${thread.id}`)).json()) as ThreadRecord;
    expect(record.status).toBe("interrupted");
  });

  it("deletes threads and projects", async () => {
    const dir = await tempDir();
    const app = makeApp(await tempDir());
    const { project, thread } = await setupThread(app, dir);

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(app, `/api/threads/${thread.id}`)).status).toBe(404);
    expect((await request(app, `/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(app, `/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("serves the change list, a file diff and a revert for a real repo", async () => {
    const dir = await tempDir();
    const repo = await gitRepo();
    // The user's own uncommitted work, from before the task ever ran: it is
    // part of the 任务基线, so nothing below may list it as the task's.
    await writeFile(join(repo, "用户自己的.txt"), "没提交的\n");

    const app = makeApp(dir, createFakeEngine({ writes: [{ path: "tracked.txt", text: "line1\n改了\n" }] }).factory);
    const { thread } = await setupThread(app, repo);
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "改一行")] }));
    await waitForStatus(app, thread.id, "idle");

    const changes = (await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as {
      branch: string | null;
      files: { path: string; status: string; additions: number }[];
    };
    expect(changes.branch).toBe("main");
    expect(changes.files).toMatchObject([{ path: "tracked.txt", status: "modified", additions: 1 }]);

    const diff = (await (await request(app, `/api/threads/${thread.id}/changes/file?path=tracked.txt`)).json()) as { diff: string };
    expect(diff.diff).toContain("+改了");

    const reverted = await postJson(app, `/api/threads/${thread.id}/changes/revert`, { path: "tracked.txt" });
    expect(await reverted.json()).toEqual({ path: "tracked.txt" });
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("line1\nline2\n");

    // Missing `path`, an unknown thread, and a path that is not actually changed.
    expect((await request(app, `/api/threads/${thread.id}/changes/file`)).status).toBe(400);
    expect((await postJson(app, `/api/threads/${thread.id}/changes/revert`, {})).status).toBe(400);
    expect((await request(app, `/api/threads/nope/changes`)).status).toBe(404);
    const missing = await request(app, `/api/threads/${thread.id}/changes/file?path=tracked.txt`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "file_not_changed" } });
  });

  it("lists the working tree, ranks a query and serves one file's content", async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, "src", "deep"), { recursive: true });
    await writeFile(join(repo, "src", "deep", "tracker.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "src", "untracked.ts"), "// 新文件\n");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(join(repo, "ignored.txt"), "看不见\n");
    await writeFile(join(repo, "blob.bin"), Buffer.from([0x41, 0x00, 0x42]));

    const app = makeApp(await tempDir());
    const { thread } = await setupThread(app, repo);
    const listing = (await (await request(app, `/api/threads/${thread.id}/files`)).json()) as {
      root: string;
      entries: { path: string; kind: string }[];
      truncated: boolean;
    };
    const paths = listing.entries.map((entry) => entry.path);

    expect(listing.root).toBe(await realpath(repo));
    expect(listing.truncated).toBe(false);
    expect(paths).toContain("tracked.txt");
    expect(paths).toContain("src/untracked.ts");
    expect(paths).not.toContain("ignored.txt");
    // Directories exist only as prefixes of the files git listed.
    expect(listing.entries).toContainEqual({ path: "src", kind: "dir" });
    expect(listing.entries).toContainEqual({ path: "src/deep", kind: "dir" });
    expect(paths).toEqual([...paths].sort());

    // 「tracke」: the basename prefix wins over the basename substring, and
    // both win over the path-wide subsequence match.
    const ranked = (await (
      await request(app, `/api/threads/${thread.id}/files?q=tracke&limit=2`)
    ).json()) as { entries: { path: string }[]; truncated: boolean };
    expect(ranked.entries.map((entry) => entry.path)).toEqual(["tracked.txt", "src/deep/tracker.ts"]);
    expect(ranked.truncated).toBe(true);

    const content = (await (
      await request(app, `/api/threads/${thread.id}/files/content?path=src%2Funtracked.ts`)
    ).json()) as { content: string; binary: boolean; truncated: boolean };
    expect(content).toEqual({ path: "src/untracked.ts", content: "// 新文件\n", truncated: false, binary: false });

    const binary = (await (await request(app, `/api/threads/${thread.id}/files/content?path=blob.bin`)).json()) as {
      binary: boolean;
      content: string;
    };
    expect(binary).toMatchObject({ binary: true, content: "" });

    // Escapes, absolute paths, a directory and a missing name are all refused.
    for (const path of ["..%2Fescape.txt", "%2Fetc%2Fpasswd", "src%2F..%2F..%2Fx"]) {
      const response = await request(app, `/api/threads/${thread.id}/files/content?path=${path}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_path" } });
    }
    expect((await request(app, `/api/threads/${thread.id}/files/content?path=src`)).status).toBe(404);
    expect((await request(app, `/api/threads/${thread.id}/files/content`)).status).toBe(400);
    expect((await request(app, "/api/threads/nope/files")).status).toBe(404);
  });

  it("serves a file's own bytes and resolves the paths tools and replies wrote", async () => {
    const repo = await gitRepo();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.png"), Buffer.from([1, 2, 3]));
    await mkdir(join(repo, "out"), { recursive: true });
    await writeFile(join(repo, "out", "鹈鹕 图.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(repo, "shot.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await symlink(join(outside, "secret.png"), join(repo, "leak.png"));

    const dataDir = await tempDir();
    const downloads = join(dataDir, "Downloads");
    const app = makeApp(dataDir);
    const { thread } = await setupThread(app, repo);
    const root = await realpath(repo);

    const png = await request(app, `/api/threads/${thread.id}/files/raw?path=shot.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-security-policy")).toContain("sandbox");
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual([0x89, 0x50, 0x00, 0x47]);

    // A model writes absolute paths as often as relative ones.
    const svg = await request(app, `/api/threads/${thread.id}/files/raw?path=${encodeURIComponent(join(root, "out", "鹈鹕 图.svg"))}`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");

    // Outside the task's directory — by path or through a symlink — is refused.
    for (const path of [join(outside, "secret.png"), "leak.png", "../escape.png"]) {
      const response = await request(app, `/api/threads/${thread.id}/files/raw?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
    }
    expect((await request(app, `/api/threads/${thread.id}/files/raw?path=nope.png`)).status).toBe(404);

    const resolved = (await (
      await postJson(app, `/api/threads/${thread.id}/files/resolve`, {
        paths: [join(root, "shot.png"), "./out/鹈鹕 图.svg", "nope.png", join(outside, "secret.png"), "leak.png"],
      })
    ).json()) as { files: { raw: string; path: string }[] };
    expect(resolved.files).toEqual([
      { raw: join(root, "shot.png"), path: "shot.png" },
      { raw: "./out/鹈鹕 图.svg", path: "out/鹈鹕 图.svg" },
    ]);
    expect((await postJson(app, `/api/threads/${thread.id}/files/resolve`, {})).status).toBe(400);

    // 「下载」 copies into the Downloads folder and never overwrites.
    const saved = (await (await postJson(app, `/api/threads/${thread.id}/files/download`, { path: join(root, "out", "鹈鹕 图.svg") })).json()) as { savedTo: string };
    expect(saved.savedTo).toBe(join(downloads, "鹈鹕 图.svg"));
    const drawn = (await (await postJson(app, `/api/threads/${thread.id}/files/download`, { svg: "<svg/>" })).json()) as { savedTo: string };
    expect(await readFile(drawn.savedTo, "utf8")).toBe("<svg/>");
    expect((await postJson(app, `/api/threads/${thread.id}/files/download`, { path: join(outside, "secret.png") })).status).toBe(400);
    expect((await postJson(app, `/api/threads/${thread.id}/files/download`, {})).status).toBe(400);
  });

  it("lists a 无项目 task's directory without git", async () => {
    const dataDir = await tempDir();
    const app = makeApp(dataDir);
    const thread = (await (await postJson(app, "/api/threads", { projectId: "no-project" })).json()) as ThreadRecord;
    const scratch = join(dataDir, "scratch", thread.id);
    await mkdir(join(scratch, "node_modules", "x"), { recursive: true });
    await writeFile(join(scratch, "node_modules", "x", "index.js"), "");
    await mkdir(join(scratch, "art"), { recursive: true });
    await writeFile(join(scratch, "art", "pelican.svg"), "<svg/>");

    const listing = (await (await request(app, `/api/threads/${thread.id}/files`)).json()) as { entries: { path: string; kind: string }[] };
    expect(listing.entries).toEqual([
      { path: "art", kind: "dir" },
      { path: "art/pelican.svg", kind: "file" },
    ]);
  });

  it("refuses to list files once the task's worktree is reclaimed", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;

    expect((await request(app, `/api/threads/${thread.id}/files`)).status).toBe(200);
    expect((await postJson(app, `/api/threads/${thread.id}/workspace/reclaim`, {})).status).toBe(200);
    const reclaimed = await request(app, `/api/threads/${thread.id}/files`);
    expect(reclaimed.status).toBe(409);
    expect(await reclaimed.json()).toMatchObject({ error: { code: "workspace_reclaimed" } });
  });

  it("runs a task in its own worktree and takes the directory back on delete", async () => {
    const dir = await tempDir();
    const repo = await gitRepo();
    const engine = createFakeEngine();
    const app = makeApp(dir, engine.factory);

    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "claude-code", workspace: "worktree" })
    ).json()) as ThreadRecord;

    expect(thread.workspace).toMatchObject({ mode: "worktree", branch: `vgent/${thread.id.slice(0, 8)}` });
    const workspacePath = thread.workspace?.path ?? "";
    expect(workspacePath).toContain(join("worktrees", thread.id));
    expect((await stat(workspacePath)).isDirectory()).toBe(true);
    // The summary the web reads carries it too.
    const listed = (await (await request(app, "/api/threads")).json()) as { threads: ThreadSummary[] };
    expect(listed.threads[0]?.workspace?.path).toBe(workspacePath);

    // The engine is pointed at the worktree, not at the project.
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "开始")] }));
    expect(engine.created[0]?.project.repoPath).toBe(workspacePath);

    // A file written in the worktree shows up for the thread and nowhere else.
    await writeFile(join(workspacePath, "tracked.txt"), "line1\n在 worktree 里改的\n");
    const changes = (await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as {
      branch: string | null;
      files: { path: string }[];
    };
    expect(changes.branch).toBe(`vgent/${thread.id.slice(0, 8)}`);
    expect(changes.files).toMatchObject([{ path: "tracked.txt" }]);
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("");

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout).not.toContain(workspacePath);
  });

  it("任务基线：worktree 里自己提交过的改动仍然算这个任务的", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    const workspacePath = thread.workspace?.path ?? "";

    // Everything the task did: a commit of its own, plus an untracked file.
    await writeFile(join(workspacePath, "tracked.txt"), "line1\nline2\n提交过的\n");
    await execFileAsync("git", ["add", "-A"], { cwd: workspacePath });
    await execFileAsync("git", ["commit", "-q", "-m", "任务自己的提交"], { cwd: workspacePath });
    await writeFile(join(workspacePath, "新文件.txt"), "还没提交\n");

    const changes = (await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as {
      files: { path: string; status: string; additions: number }[];
    };
    expect(changes.files).toMatchObject([
      { path: "tracked.txt", status: "modified", additions: 1 },
      { path: "新文件.txt", status: "untracked", additions: 1 },
    ]);

    const diff = (await (await request(app, `/api/threads/${thread.id}/changes/file?path=tracked.txt`)).json()) as { diff: string };
    expect(diff.diff).toContain("+提交过的");

    // 还原 puts the file back the way the *baseline* had it, commit or no commit.
    expect((await postJson(app, `/api/threads/${thread.id}/changes/revert`, { path: "tracked.txt" })).status).toBe(200);
    expect(await readFile(join(workspacePath, "tracked.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("收口：提交后任务记下 outcome 和改动统计", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    const workspacePath = thread.workspace?.path ?? "";
    await writeFile(join(workspacePath, "tracked.txt"), "line1\nline2\n加一行\n");

    const status = (await (await request(app, `/api/threads/${thread.id}/integration`)).json()) as {
      mode: string;
      dirty: boolean;
      canCommit: boolean;
      pr: { available: boolean; reason?: string };
    };
    expect(status).toMatchObject({ mode: "worktree", dirty: true, canCommit: true });
    expect(status.pr).toEqual({ available: false, reason: "仓库没有远端，开不了 PR" });

    const committed = (await (
      await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "commit", message: "收个口" })
    ).json()) as ThreadRecord;
    expect(committed.outcome).toMatchObject({ kind: "committed" });
    expect(committed.changeStats).toEqual({ files: 1, additions: 1, deletions: 0 });

    const bad = await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_action" } });
  });

  it("带回主目录：409 带着冲突清单，标记模式落地，撤销还能回去", async () => {
    const repo = await gitRepo();
    const dir = await tempDir();
    const app = makeApp(dir);
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    const work = thread.workspace?.path ?? "";

    // Both sides rewrote the same line, and the task added a file of its own.
    await writeFile(join(work, "tracked.txt"), "任务写的\nline2\n");
    await writeFile(join(repo, "tracked.txt"), "用户写的\nline2\n");
    await writeFile(join(work, "只有任务动的.txt"), "任务建的\n");

    const refused = await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "apply" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "apply_conflict", details: { conflicts: [{ path: "tracked.txt", resolution: "markers" }] } },
    });
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("用户写的\nline2\n");

    const applied = (await (
      await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "apply", conflicts: "markers" })
    ).json()) as ThreadRecord & { apply: { applied: string[]; conflicts: { path: string }[] } };
    expect(applied.outcome).toMatchObject({ kind: "applied" });
    expect(applied.apply).toMatchObject({ applied: ["只有任务动的.txt"], conflicts: [{ path: "tracked.txt" }] });
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toContain("<<<<<<< 你的改动");
    expect(applied.applyUndo?.files).toHaveLength(2);

    // 撤销带回 is offered only while that record is there.
    const status = (await (await request(app, `/api/threads/${thread.id}/integration`)).json()) as { canUndoApply: boolean };
    expect(status.canUndoApply).toBe(true);

    const undone = (await (
      await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "undo-apply" })
    ).json()) as ThreadRecord & { undo: { restored: string[]; kept: string[] } };
    expect(undone.outcome).toBeUndefined();
    expect(undone.applyUndo).toBeUndefined();
    expect(undone.undo.restored.sort()).toEqual(["tracked.txt", "只有任务动的.txt"].sort());
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("用户写的\nline2\n");
    expect(await stat(join(repo, "只有任务动的.txt")).catch(() => null)).toBeNull();
  });

  it("PR 链接不随新一轮消失，归档会丢掉带回的撤销点", async () => {
    const repo = await gitRepo();
    const dir = await tempDir();
    const app = makeApp(dir);
    const store = createThreadStore(dir);
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;

    await writeFile(join(thread.workspace?.path ?? "", "tracked.txt"), "line1\nline2\n任务加的\n");
    await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "apply", conflicts: "markers" });
    const pr = { url: "https://github.com/acme/repo/pull/9", kind: "pr" as const, number: 9, at: new Date().toISOString() };
    await store.update(thread.id, { pr });

    // What the start of a turn does: the 收口态 goes, the PR does not.
    const afterTurn = await store.update(thread.id, { outcome: undefined });
    expect(afterTurn.pr).toEqual(pr);
    expect(afterTurn.applyUndo).toBeDefined();

    const archived = (await (
      await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) })
    ).json()) as ThreadRecord;
    expect(archived.pr).toEqual(pr);
    expect(archived.applyUndo).toBeUndefined();
  });

  it("主目录任务：改动、统计和提交都只算任务自己的", async () => {
    const repo = await gitRepo();
    await writeFile(join(repo, "a.txt"), "一\n");
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync("git", ["commit", "-q", "-m", "再来一个"], { cwd: repo });

    // The user's own uncommitted work: modified, untracked, staged.
    await writeFile(join(repo, "tracked.txt"), "line1\nline2\n用户改的\n");
    await writeFile(join(repo, "用户没跟踪的.txt"), "用户建的\n");
    await writeFile(join(repo, "用户暂存的.txt"), "用户 add 过的\n");
    await execFileAsync("git", ["add", "用户暂存的.txt"], { cwd: repo });
    const porcelain = async () => (await execFileAsync("git", ["status", "--porcelain"], { cwd: repo })).stdout;
    const dirtyBefore = await porcelain();

    const dataDir = await tempDir();
    const engine = createFakeEngine({
      writes: [
        { path: "a.txt", text: "一\n任务加的\n" },
        { path: "b.txt", text: "任务建的\n" },
      ],
    });
    const app = makeApp(dataDir, engine.factory);
    const { thread } = await setupThread(app, repo);
    const record = async () => (await (await request(app, `/api/threads/${thread.id}`)).json()) as ThreadRecord;
    const changesOf = async () =>
      (await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as { files: { path: string; status: string; additions: number }[] };

    // Before its first turn a task has no baseline, so it has changed nothing —
    // whatever is lying around is the user's. Nothing counts it either, so the
    // task never shows a 审查 pill and never lands in 待验收.
    expect((await record()).changeStats).toBeUndefined();
    expect((await changesOf()).files).toEqual([]);
    expect((await record()).changeStats).toEqual({ files: 0, additions: 0, deletions: 0 });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "改两个文件")] }));
    await waitForStatus(app, thread.id, "idle");

    expect((await changesOf()).files).toMatchObject([
      { path: "a.txt", status: "modified", additions: 1 },
      { path: "b.txt", status: "added", additions: 1 },
    ]);
    const afterTurn = await record();
    expect(afterTurn.changeStats).toEqual({ files: 2, additions: 2, deletions: 0 });
    expect(afterTurn.baselineCommit).toMatch(/^[0-9a-f]{40}$/);

    // `/compact` replaces the messages; the baseline is on the record, not on one of them.
    await createThreadStore(dataDir).update(thread.id, { messages: [userMessage("s1", "摘要")] });
    expect((await record()).baselineCommit).toBe(afterTurn.baselineCommit);
    expect((await changesOf()).files).toHaveLength(2);

    const status = (await (await request(app, `/api/threads/${thread.id}/integration`)).json()) as {
      canCommit: boolean;
      commitFiles: number;
      note?: string;
    };
    expect(status).toMatchObject({ canCommit: true, commitFiles: 2 });
    expect(status.note).toBeUndefined();

    const committed = (await (
      await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "commit", message: "只提交任务改的" })
    ).json()) as ThreadRecord;
    expect(committed.outcome).toMatchObject({ kind: "committed" });
    expect(committed.changeStats).toEqual({ files: 0, additions: 0, deletions: 0 });
    // The baseline moved past the commit, so what it carried stops counting.
    expect(committed.baselineCommit).not.toBe(afterTurn.baselineCommit);

    const shown = (await execFileAsync("git", ["-c", "core.quotepath=false", "show", "--pretty=format:", "--name-only", "HEAD"], { cwd: repo })).stdout;
    expect(shown.split("\n").filter((line) => line.trim() !== "")).toEqual(["a.txt", "b.txt"]);
    // The user's three changes are still exactly what they were.
    expect(await porcelain()).toBe(dirtyBefore);

    expect((await changesOf()).files).toEqual([]);
    const again = await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "commit", message: "再来一次" });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "nothing_to_commit" } });
  });

  it("看变更时顺手把过期的统计改正过来", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    const workspacePath = thread.workspace?.path ?? "";
    const record = async () => (await (await request(app, `/api/threads/${thread.id}`)).json()) as ThreadRecord;

    expect((await record()).changeStats).toBeUndefined();
    await writeFile(join(workspacePath, "tracked.txt"), "line1\nline2\n加一行\n");
    await request(app, `/api/threads/${thread.id}/changes`);
    expect((await record()).changeStats).toEqual({ files: 1, additions: 1, deletions: 0 });

    // Undone outside Vgent: the panel counts zero, so the record must say zero.
    await writeFile(join(workspacePath, "tracked.txt"), "line1\nline2\n");
    await request(app, `/api/threads/${thread.id}/changes`);
    expect((await record()).changeStats).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("启动时给没有统计的老任务补算改动", async () => {
    const repo = await gitRepo();
    const dir = await tempDir();
    const first = makeApp(dir);
    const project = (await (await postJson(first, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(first, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    // A task that never ran a turn under M1 has no `changeStats` at all.
    await writeFile(join(thread.workspace?.path ?? "", "新文件.txt"), "一行\n");
    expect(((await (await request(first, `/api/threads/${thread.id}`)).json()) as ThreadRecord).changeStats).toBeUndefined();

    const second = makeApp(dir);
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = (await (await request(second, `/api/threads/${thread.id}`)).json()) as ThreadRecord;
      if (record.changeStats != null) {
        expect(record.changeStats).toEqual({ files: 1, additions: 1, deletions: 0 });
        return;
      }
      await sleep(20);
    }
    throw new Error("启动补算没有写入 changeStats");
  });

  it("等审批的任务不能收口也不能归档，但可以删除", async () => {
    const repo = await gitRepo();
    const dir = await tempDir();
    const app = makeApp(dir);
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    await writeFile(join(thread.workspace?.path ?? "", "tracked.txt"), "line1\nline2\n改了\n");

    // The turn is parked on an approval: no run entry, but the engine is alive.
    await createThreadStore(dir).update(thread.id, { status: "awaiting-approval" });

    const integrate = await postJson(app, `/api/threads/${thread.id}/integrate`, { action: "commit", message: "不该成功" });
    expect(integrate.status).toBe(409);
    expect(await integrate.json()).toMatchObject({ error: { code: "thread_running" } });

    const archive = await request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    expect(archive.status).toBe(409);
    expect(await archive.json()).toMatchObject({ error: { code: "thread_running" } });

    // And nothing was committed behind its back.
    expect((await execFileAsync("git", ["log", "--oneline"], { cwd: thread.workspace?.path ?? "" })).stdout.trim().split("\n")).toHaveLength(1);
    // 删除 stops the run first, so it is still allowed.
    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("归档：worktree 目录消失，取消归档又回来", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" })
    ).json()) as ThreadRecord;
    const workspacePath = thread.workspace?.path ?? "";
    await writeFile(join(workspacePath, "未提交.txt"), "任务留下的\n");

    const patch = (body: unknown) => request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) });

    const archived = (await (await patch({ archived: true })).json()) as ThreadRecord;
    expect(archived.archivedAt).toEqual(expect.any(String));
    expect(archived.workspace?.reclaimed).toBe(true);
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    // The summary the sidebar groups on carries it too.
    const listed = (await (await request(app, "/api/threads")).json()) as { threads: ThreadSummary[] };
    expect(listed.threads[0]?.archivedAt).toBe(archived.archivedAt);

    const restored = (await (await patch({ archived: false })).json()) as ThreadRecord;
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.workspace?.reclaimed).toBeUndefined();
    expect(await readFile(join(workspacePath, "未提交.txt"), "utf8")).toBe("任务留下的\n");

    const wrong = await patch({ archived: "yes" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: { code: "invalid_archived" } });
  });

  it("回合结束时记下改动统计", async () => {
    const repo = await gitRepo();
    const engine = createFakeEngine({ writes: [{ path: "引擎写的.txt", text: "一行\n" }] });
    const app = makeApp(await tempDir(), engine.factory);
    const { thread } = await setupThread(app, repo);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "开始")] }));
    // The stream closes before the turn's final write; that write is what carries the stats.
    const after = await waitForStatus(app, thread.id, "idle");
    expect(after.changeStats).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("rejects an unknown kind on the native picker route", async () => {
    const app = makeApp(await tempDir());
    const rejected = await postJson(app, "/api/projects/pick", { kind: "nope" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "invalid_pick_kind" } });
  });

  it("reads and writes settings", async () => {
    const app = makeApp(await tempDir());
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({
      defaultEngine: "vgent",
      runMode: "allow-reads",
      allowlist: [],
    });
    const updated = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ runMode: "allow-edits" }) });
    expect(await updated.json()).toMatchObject({ runMode: "allow-edits" });
  });

  it("系统通知默认开：只有明确关掉才落盘，再打开就把这个字段去掉", async () => {
    const app = makeApp(await tempDir());
    const put = (body: unknown) => request(app, "/api/settings", { method: "PUT", body: JSON.stringify(body) });

    expect((await (await request(app, "/api/settings")).json()).systemNotifications).toBeUndefined();
    expect((await (await put({ systemNotifications: false })).json()).systemNotifications).toBe(false);
    expect((await (await put({ systemNotifications: true })).json()).systemNotifications).toBeUndefined();
  });

  it("serves a built web app at / with an SPA fallback, without touching /api", async () => {
    const webDist = await tempDir();
    await mkdir(join(webDist, "assets"), { recursive: true });
    await writeFile(join(webDist, "index.html"), "<!doctype html><title>Vgent</title>");
    await writeFile(join(webDist, "assets", "x.js"), "export const x = 1;\n");
    const app = makeApp(await tempDir(), undefined, webDist);

    const root = await app.app.request(`${ORIGIN}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>Vgent</title>");

    // A client-rendered route is not a file, so it gets the shell.
    expect(await (await app.app.request(`${ORIGIN}/threads/abc`)).text()).toContain("<title>Vgent</title>");

    const asset = await app.app.request(`${ORIGIN}/assets/x.js`);
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(await asset.text()).toBe("export const x = 1;\n");

    // `/api` keeps its auth and its 404s; it never falls back to index.html.
    expect((await app.app.request(`${ORIGIN}/api/projects`)).status).toBe(401);
    expect((await request(app, "/api/nope")).status).toBe(404);
    expect((await app.app.request("http://evil.example.com/")).status).toBe(403);
  });

  /** The pre-compact history the success test seeds every thread with. */
  const historyBeforeCompact: UIMessage[] = [
    userMessage("m1", "把登录页改成中文"),
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "改好了" }] },
    userMessage("m3", "再加个按钮"),
  ];

  /** The `<id>.pre-compact.*.json` sidecars left in `<dataDir>/threads/` for one thread. */
  const snapshotFilesFor = async (dataDir: string, threadId: string): Promise<string[]> =>
    (await readdir(join(dataDir, "threads"))).filter((entry) => entry.startsWith(`${threadId}.pre-compact.`));

  it("压缩上下文：把自研引擎任务的历史换成一条摘要，并记下原来的条数，同时在盘上留一份旧消息快照", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);
    const { thread } = await setupThread(app, await tempDir(), "vgent");

    // The store is the shortest way to a thread with a history: no engine has
    // to run for the route's precondition to be interesting.
    await createThreadStore(dataDir).update(thread.id, { messages: historyBeforeCompact });

    const response = await postJson(app, `/api/threads/${thread.id}/compact`, {});
    expect(response.status).toBe(200);
    const record = (await response.json()) as ThreadRecord;
    expect(record.messages).toHaveLength(2);
    expect(JSON.stringify(record.messages[0]!.parts)).toContain("摘要内容");
    expect((record.messages[0]!.metadata as ThreadMessageMetadata).compacted).toMatchObject({ before: 3 });
    expect(record.messages[1]!.role).toBe("assistant");

    const snapshots = await snapshotFilesFor(dataDir, thread.id);
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(join(dataDir, "threads", snapshots[0]!), "utf8")) as ThreadPreCompactSnapshot;
    expect(snapshot).toMatchObject({ version: 1, threadId: thread.id, messages: historyBeforeCompact });
  });

  it("压缩上下文：同一线程连续压缩两次，两份快照都留下且互不覆盖", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);
    const { thread } = await setupThread(app, await tempDir(), "vgent");
    await createThreadStore(dataDir).update(thread.id, { messages: historyBeforeCompact });

    expect((await postJson(app, `/api/threads/${thread.id}/compact`, {})).status).toBe(200);
    // The route's own minimum is "at least 2 messages", and a compact always
    // leaves exactly 2 (the summary + the ack), so it can run right again.
    expect((await postJson(app, `/api/threads/${thread.id}/compact`, {})).status).toBe(200);

    const snapshots = await snapshotFilesFor(dataDir, thread.id);
    expect(snapshots).toHaveLength(2);
  });

  // Root ignores directory write permissions, which would make the chmod below a no-op.
  it.skipIf(process.getuid?.() === 0)("压缩上下文：快照写失败就整体失败，线程消息保持原样", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);
    const { thread } = await setupThread(app, await tempDir(), "vgent");
    await createThreadStore(dataDir).update(thread.id, { messages: historyBeforeCompact });

    const threadsDir = join(dataDir, "threads");
    await chmod(threadsDir, 0o500); // read+traverse only: writing the new snapshot file fails.
    try {
      const response = await postJson(app, `/api/threads/${thread.id}/compact`, {});
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "snapshot_failed" } });
    } finally {
      await chmod(threadsDir, 0o700); // restore before afterEach removes the temp dir.
    }

    expect((await snapshotFilesFor(dataDir, thread.id)).length).toBe(0);
    const record = (await createThreadStore(dataDir).get(thread.id)) as ThreadRecord;
    expect(record.messages).toEqual(historyBeforeCompact);
  });

  it("压缩上下文：Claude Code 是让它自己压——/compact 作为一轮送进去，带着标记", async () => {
    const dataDir = await tempDir();
    const fake = createFakeEngine({ text: "压好了" });
    const app = makeApp(dataDir, fake.factory);
    const { thread } = await setupThread(app, await tempDir(), "claude-code");
    await createThreadStore(dataDir).update(thread.id, { messages: historyBeforeCompact });

    const response = await postJson(app, `/api/threads/${thread.id}/compact`, {});
    expect(response.status).toBe(200);
    expect(((await response.json()) as ThreadRecord).status).toBe("running");

    const record = await waitForStatus(app, thread.id, "idle");
    // Nothing of ours was rewritten: the history is intact, the request is a
    // user message the runtime saw as `/compact`, and the marker sits on it.
    expect(record.messages.slice(0, historyBeforeCompact.length)).toEqual(historyBeforeCompact);
    const request = record.messages[historyBeforeCompact.length]!;
    expect(request.role).toBe("user");
    expect(request.parts).toEqual([{ type: "text", text: "/compact" }]);
    expect((request.metadata as ThreadMessageMetadata).compacted).toMatchObject({ before: historyBeforeCompact.length });
    expect(fake.streamed.at(-1)?.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "/compact" }] });
  });

  it("压缩上下文：harness 自己压了，回合里留下一个 data-compaction 标记而不是报未知事件", async () => {
    const dataDir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          async stream() {
            const parts = (async function* (): AsyncGenerator<TextStreamPart<ToolSet>> {
              yield { type: "start" };
              // What the harness emits when its runtime compacted — not a part the AI SDK's UI stream knows.
              yield { type: "compaction", trigger: "auto", summary: "摘要", tokensBefore: 180000, tokensAfter: 12000 } as unknown as TextStreamPart<ToolSet>;
              yield { type: "text-start", id: "t1" };
              yield { type: "text-delta", id: "t1", text: "继续" };
              yield { type: "text-end", id: "t1" };
            })();
            return { stream: ReadableStream.from(parts) as ReadableStream<TextStreamPart<ToolSet>> };
          },
          hasUnfinishedTurn: () => false,
          async destroy() {},
          async finish() {},
        };
      },
    };
    const app = makeApp(dataDir, factory);
    const { thread } = await setupThread(app, await tempDir(), "claude-code");
    const response = await postJson(app, `/api/chat/${thread.id}`, { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "干活" }] }] });
    expect(response.status).toBe(200);
    await response.text();
    const record = await waitForStatus(app, thread.id, "idle");
    const assistant = record.messages.at(-1)!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts).toContainEqual(expect.objectContaining({ type: "data-compaction", data: { trigger: "auto", tokensBefore: 180000, tokensAfter: 12000 } }));
    expect(assistant.parts).toContainEqual(expect.objectContaining({ type: "text", text: "继续" }));
  });

  it("压缩上下文：Codex 没有手动压缩，空对话也被挡住", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);

    const { thread: harness } = await setupThread(app, await tempDir(), "codex");
    const unsupported = await postJson(app, `/api/threads/${harness.id}/compact`, {});
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: { code: "compact_unsupported" } });

    const { thread: fresh } = await setupThread(app, await tempDir(), "vgent");
    const empty = await postJson(app, `/api/threads/${fresh.id}/compact`, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: "compact_empty" } });
  });

  it("serves a model catalog per engine and rejects an unknown one", async () => {
    // Without a key the Claude Code catalog is the builtin alias list, so the
    // route answers without touching the network.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const app = makeApp(await tempDir());

    const unknown = await request(app, "/api/engines/nope/models");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_engine" } });

    const response = await request(app, "/api/engines/claude-code/models");
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as { engine: string; models: Array<{ id: string }>; source: string };
    expect(catalog.engine).toBe("claude-code");
    expect(Array.isArray(catalog.models)).toBe(true);
    expect(catalog.models.map((entry) => entry.id)).toContain("sonnet");
  });

  it("names the model each engine falls back to when a task picks none", async () => {
    // A codex home with no login and no gateway key keeps both lists builtin,
    // so the route answers without touching the network.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODEX_HOME", await tempDir());
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const app = makeApp(await tempDir());
    const defaultModelOf = async (engine: string): Promise<string | undefined> =>
      ((await (await request(app, `/api/engines/${engine}/models`)).json()) as { defaultModel?: string }).defaultModel;

    expect(await defaultModelOf("vgent")).toBe(DEFAULT_VGENT_MODEL);
    // Claude Code's harness picks its own; the server must not invent one.
    expect(await defaultModelOf("claude-code")).toBeUndefined();

    // `defaultModel` belongs to `defaultEngine` — here Claude Code — so it
    // answers for that engine only; the others keep their own answer.
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ defaultEngine: "claude-code", defaultModel: "sonnet" }) });
    expect(await defaultModelOf("claude-code")).toBe("sonnet");
    expect(await defaultModelOf("vgent")).toBe(DEFAULT_VGENT_MODEL);
  });
});
