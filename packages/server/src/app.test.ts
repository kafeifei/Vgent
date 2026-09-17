import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry, type EngineContext, type EngineFactory } from "./engines/registry.js";
import type { HarnessState, Project, ThreadRecord, ThreadSummary } from "./types.js";

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
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

function makeApp(dataDir: string, factory?: EngineFactory): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
    ...(factory != null ? { registry: createEngineRegistry({ "claude-code": factory }) } : {}),
  });
  apps.push(instance);
  return instance;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-app-"));
  dirs.push(dir);
  return dir;
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

  it("rejects an unknown thread, bad messages and an unwired engine", async () => {
    const dir = await tempDir();
    const fake = createFakeEngine();
    const app = makeApp(dir, fake.factory);
    const { project, thread } = await setupThread(app, dir);

    expect((await postJson(app, "/api/chat/nope", { messages: [userMessage("u1", "hi")] })).status).toBe(404);
    expect((await postJson(app, `/api/chat/${thread.id}`, {})).status).toBe(400);
    expect((await postJson(app, `/api/chat/${thread.id}`, { messages: [{ role: "user" }] })).status).toBe(400);

    const codexThread = (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "codex" })
    ).json()) as ThreadRecord;
    // An unwired engine is knowable without touching a sandbox, so it is a 501
    // rather than an error part inside a 200 stream.
    const response = await postJson(app, `/api/chat/${codexThread.id}`, { messages: [userMessage("u1", "hi")] });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: { code: "engine_not_implemented" } });
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

  it("reads and writes settings", async () => {
    const app = makeApp(await tempDir());
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({ defaultEngine: "claude-code" });
    const updated = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ defaultPermissionMode: "allow-edits" }) });
    expect(await updated.json()).toMatchObject({ defaultPermissionMode: "allow-edits" });
  });
});
