import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LanguageModel, ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry, type EngineContext, type EngineFactory } from "./engines/registry.js";
import { DEFAULT_VGENT_MODEL } from "./engines/vgent.js";
import { EngineUnavailableError } from "./errors.js";
import { createThreadStore } from "./store/threads.js";
import type { HarnessState, Project, ThreadMessageMetadata, ThreadRecord, ThreadSummary } from "./types.js";

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
function createFakeEngine(options?: { text?: string; deltaDelayMs?: number }) {
  const created: EngineContext[] = [];
  const streamed: ModelMessage[][] = [];
  const text = options?.text ?? "你好 世界 来自 假引擎";
  const delay = options?.deltaDelayMs ?? 0;
  let turn = 0;

  const factory: EngineFactory = {
    async create(ctx) {
      created.push(ctx);
      const sessionTurn = ++turn;
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

function makeApp(dataDir: string, factory?: EngineFactory, webDist?: string): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
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

/** A model that answers one `generateText` call with `text` — what `/compact` needs and nothing else. */
const summariser = (text: string): LanguageModel =>
  new MockLanguageModelV3({
    doGenerate: [
      {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, reasoning: undefined },
          totalTokens: undefined,
        },
        warnings: [],
      },
    ],
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
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ defaultModel: "openai/gpt-5.5" }) });

    const picked = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent", model: "codex-subscription:gpt-5.5" })
    ).json()) as ThreadRecord;
    expect(picked.model).toBe("codex-subscription:gpt-5.5");

    const defaulted = (await (await postJson(app, "/api/threads", { projectId: project.id, engine: "vgent" })).json()) as ThreadRecord;
    expect(defaulted.model).toBe("openai/gpt-5.5");
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

  it("refuses a codex thread in any permission mode but allow-all", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createFakeEngine().factory);
    const project = (await (await postJson(app, "/api/projects", { repoPath: dir })).json()) as Project;

    // The default permission mode is `allow-reads`, which Codex cannot honour.
    const rejected = await postJson(app, "/api/threads", { projectId: project.id, engine: "codex" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "codex_permission_mode" } });

    const created = await postJson(app, "/api/threads", { projectId: project.id, engine: "codex", permissionMode: "allow-all" });
    expect(created.status).toBe(200);
    const codexThread = (await created.json()) as ThreadRecord;

    // And the same rule applies to a patch that would put it back in a mode it cannot run in.
    const patched = await request(app, `/api/threads/${codexThread.id}`, {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: "allow-edits" }),
    });
    expect(patched.status).toBe(400);
    expect(await patched.json()).toMatchObject({ error: { code: "codex_permission_mode" } });
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

  it("keeps a per-thread tool allowlist, editable even mid-run", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine({ deltaDelayMs: 25 });
    const app = makeApp(dir, fake.factory);
    const { thread } = await setupThread(app, dir);
    const patch = (body: unknown) =>
      request(app, `/api/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) });

    // Deduped on the way in, and it reaches the summary the SSE snapshot carries.
    const set = await patch({ alwaysAllow: ["bash", "write", "bash"] });
    expect(set.status).toBe(200);
    expect((await set.json()) as ThreadRecord).toMatchObject({ alwaysAllow: ["bash", "write"] });
    const summaries = (await (await request(app, "/api/threads")).json()) as { threads: ThreadSummary[] };
    expect(summaries.threads[0]).toMatchObject({ alwaysAllow: ["bash", "write"] });

    for (const bad of [{ alwaysAllow: "bash" }, { alwaysAllow: ["bash", ""] }, { alwaysAllow: [1] }]) {
      const rejected = await patch(bad);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: "invalid_always_allow" } });
    }

    // An allowlist edit only steers future decisions, so unlike every other
    // field it is accepted while the thread is running.
    const run = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] });
    await (await waitForLiveStream(app, thread.id)).body?.cancel();
    expect((await patch({ alwaysAllow: ["bash"] })).status).toBe(200);
    expect((await patch({ alwaysAllow: ["bash"], title: "顺手改名" })).status).toBe(409);
    await readSse(await run);
    await waitForStatus(app, thread.id, "idle");

    // An empty list is how the UI clears it, and the field goes away with it.
    const cleared = (await (await patch({ alwaysAllow: [] })).json()) as ThreadRecord;
    expect(cleared.alwaysAllow).toBeUndefined();
  });

  it("turns an unavailable engine into a 503 before the run starts", async () => {
    const dir = await tempDir();
    const factory: EngineFactory = {
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
    await writeFile(join(repo, "tracked.txt"), "line1\n改了\n");

    const app = makeApp(dir);
    const { thread } = await setupThread(app, repo);

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

  it("rejects an unknown kind on the native picker route", async () => {
    const app = makeApp(await tempDir());
    const rejected = await postJson(app, "/api/projects/pick", { kind: "nope" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: "invalid_pick_kind" } });
  });

  it("reads and writes settings", async () => {
    const app = makeApp(await tempDir());
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({ defaultEngine: "claude-code" });
    const updated = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ defaultPermissionMode: "allow-edits" }) });
    expect(await updated.json()).toMatchObject({ defaultPermissionMode: "allow-edits" });
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

  it("压缩上下文：把自研引擎任务的历史换成一条摘要，并记下原来的条数", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);
    const { thread } = await setupThread(app, await tempDir(), "vgent");

    // The store is the shortest way to a thread with a history: no engine has
    // to run for the route's precondition to be interesting.
    await createThreadStore(dataDir).update(thread.id, {
      messages: [
        userMessage("m1", "把登录页改成中文"),
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "改好了" }] },
        userMessage("m3", "再加个按钮"),
      ],
    });

    const response = await postJson(app, `/api/threads/${thread.id}/compact`, {});
    expect(response.status).toBe(200);
    const record = (await response.json()) as ThreadRecord;
    expect(record.messages).toHaveLength(2);
    expect(JSON.stringify(record.messages[0]!.parts)).toContain("摘要内容");
    expect((record.messages[0]!.metadata as ThreadMessageMetadata).compacted).toMatchObject({ before: 3 });
    expect(record.messages[1]!.role).toBe("assistant");
  });

  it("压缩上下文：其他引擎和空对话都被挡住", async () => {
    const dataDir = await tempDir();
    const app = createApp({ dataDir, token: TOKEN, compactModel: summariser("摘要内容") });
    apps.push(app);

    const { thread: harness } = await setupThread(app, await tempDir(), "claude-code");
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

    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ defaultModel: "sonnet" }) });
    expect(await defaultModelOf("vgent")).toBe("sonnet");
    expect(await defaultModelOf("claude-code")).toBe("sonnet");
  });
});
