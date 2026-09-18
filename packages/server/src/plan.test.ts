import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream, type LanguageModel, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry } from "./engines/registry.js";
import { createVgentEngineFactory } from "./engines/vgent.js";
import { MAX_PLAN_BYTES } from "./store/plans.js";
import type { Project, ThreadRecord } from "./types.js";

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-plan-"));
  dirs.push(dir);
  return dir;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

const auth = { authorization: `Bearer ${TOKEN}` };

function request(app: VgentApp, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...auth, ...(init?.body != null ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
}

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });
const patchJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "PATCH", body: JSON.stringify(body) });
const putJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "PUT", body: JSON.stringify(body) });

/** Drains a chat response; the turn itself finishes on the server afterwards. */
async function readSse(response: Response): Promise<void> {
  await response.text();
}

async function waitForStatus(app: VgentApp, threadId: string, wanted: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
    if (record.status === wanted) return record;
    await sleep(20);
  }
  throw new Error(`线程 ${threadId} 没有进入状态 ${wanted}`);
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const NO_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, reasoning: undefined },
  totalTokens: undefined,
};

const toolCallStream = (toolCallId: string, toolName: string, input: unknown) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: toolCallId, toolName },
      { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
      { type: "tool-input-end", id: toolCallId },
      { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
      { type: "finish", finishReason: { unified: "tool-calls" }, usage: NO_USAGE },
    ],
  }),
});

/** One `doStream` result shaped like a real step: the agent narrates, then calls a tool. */
const narrateThenToolCall = (narration: string, toolCallId: string, toolName: string, input: unknown) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "n1" },
      { type: "text-delta", id: "n1", delta: narration },
      { type: "text-end", id: "n1" },
      { type: "tool-input-start", id: toolCallId, toolName },
      { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
      { type: "tool-input-end", id: toolCallId },
      { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
      { type: "finish", finishReason: { unified: "tool-calls" }, usage: NO_USAGE },
    ],
  }),
});

const textStream = (text: string) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: text },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: { unified: "stop" }, usage: NO_USAGE },
    ],
  }),
});

/** A step that produces nothing at all — the turn stops right after a tool call. */
const emptyStream = () => ({
  stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "finish", finishReason: { unified: "stop" }, usage: NO_USAGE },
    ],
  }),
});

const mockModel = (results: unknown[]): LanguageModel => new MockLanguageModelV3({ doStream: results as never }) as unknown as LanguageModel;

/** The real `createVgentEngineFactory`, only its model replaced — see `runs.test.ts`. */
function makeApp(dataDir: string, model?: LanguageModel): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
    ...(model != null ? { registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model }) }) } : {}),
  });
  apps.push(instance);
  return instance;
}

async function makeThread(app: VgentApp, repoPath: string, body: Record<string, unknown> = {}): Promise<Response> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  return postJson(app, "/api/threads", { projectId: project.id, title: "计划", engine: "vgent", ...body });
}

const PLAN_TEXT = "## 目标\n给 README 加一节 Usage\n\n## 步骤\n1. 改 README.md\n";
/** What the agent says *before* it starts reading — never part of the plan. */
const NARRATION = "我先看一下 README.md 现状。";
const WRITE_INPUT = { file_path: "SMOKE.txt", content: "写好了\n" };

describe("模式 validation", () => {
  it("creates a thread in Plan mode and refuses an engine that cannot run one", async () => {
    const app = makeApp(await tempDir());
    const repoPath = await tempDir();

    const planned = (await (await makeThread(app, repoPath, { mode: "plan" })).json()) as ThreadRecord;
    expect(planned.mode).toBe("plan");

    // Codex cannot run read-only, so the capability table refuses the mode outright.
    const refused = await makeThread(app, repoPath, { mode: "plan", engine: "codex" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("plan_unsupported");

    const nonsense = await makeThread(app, repoPath, { mode: "建议" });
    expect(nonsense.status).toBe(400);
    expect(((await nonsense.json()) as { error: { code: string } }).error.code).toBe("invalid_mode");
  });

  it("agent 模式 leaves the field off the record, and PATCH moves it both ways", async () => {
    const app = makeApp(await tempDir());
    const repoPath = await tempDir();
    const thread = (await (await makeThread(app, repoPath)).json()) as ThreadRecord;
    expect(thread.mode).toBeUndefined();

    const planned = (await (await patchJson(app, `/api/threads/${thread.id}`, { mode: "plan" })).json()) as ThreadRecord;
    expect(planned.mode).toBe("plan");

    const back = (await (await patchJson(app, `/api/threads/${thread.id}`, { mode: "agent" })).json()) as ThreadRecord;
    expect(back.mode).toBeUndefined();
  });

  it("refuses a PATCH that would leave a Plan task on an engine without Plan mode", async () => {
    const app = makeApp(await tempDir());
    const repoPath = await tempDir();
    const thread = (await (await makeThread(app, repoPath, { mode: "plan" })).json()) as ThreadRecord;

    const refused = await patchJson(app, `/api/threads/${thread.id}`, { engine: "codex", model: "gpt-5.5" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("plan_unsupported");
  });
});

describe("计划文档", () => {
  it("round-trips through GET / PUT, caps the size, and is deleted with the task", async () => {
    const dataDir = await tempDir();
    const app = makeApp(dataDir);
    const repoPath = await tempDir();
    const thread = (await (await makeThread(app, repoPath, { mode: "plan" })).json()) as ThreadRecord;
    const planPath = join(dataDir, "plans", `${thread.id}.md`);

    // No turn has run, so the document is empty rather than missing.
    expect(await (await request(app, `/api/threads/${thread.id}/plan`)).json()).toEqual({ content: "" });

    const saved = (await (await putJson(app, `/api/threads/${thread.id}/plan`, { content: PLAN_TEXT })).json()) as {
      content: string;
      updatedAt: string;
    };
    expect(saved.content).toBe(PLAN_TEXT);
    expect(typeof saved.updatedAt).toBe("string");
    expect(await readFile(planPath, "utf8")).toBe(PLAN_TEXT);
    expect(await (await request(app, `/api/threads/${thread.id}/plan`)).json()).toMatchObject({ content: PLAN_TEXT });

    const tooBig = await putJson(app, `/api/threads/${thread.id}/plan`, { content: "x".repeat(MAX_PLAN_BYTES + 1) });
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: { code: string } }).error.code).toBe("plan_too_large");

    const notAString = await putJson(app, `/api/threads/${thread.id}/plan`, { content: 42 });
    expect(notAString.status).toBe(400);
    expect(((await notAString.json()) as { error: { code: string } }).error.code).toBe("invalid_plan");
    // The rejected writes left the stored document alone.
    expect(await readFile(planPath, "utf8")).toBe(PLAN_TEXT);

    await request(app, `/api/threads/${thread.id}`, { method: "DELETE" });
    expect(await exists(planPath)).toBe(false);
  });

  it("refuses to save the document, or to change 模式, under a parked turn", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    // An Agent turn that stops for a write approval: the thread is live, but no
    // run is in flight — exactly the case a plain `isRunning` check would miss.
    const app = makeApp(dataDir, mockModel([toolCallStream("call-w", "write", WRITE_INPUT), textStream("写完了")]));
    const thread = (await (await makeThread(app, repoPath)).json()) as ThreadRecord;
    // 运行模式 defaults to 自动改文件, which would not stop for a write at all.
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ runMode: "allow-reads" }) });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "新建 SMOKE.txt")] }));
    await waitForStatus(app, thread.id, "awaiting-approval");

    const put = await putJson(app, `/api/threads/${thread.id}/plan`, { content: PLAN_TEXT });
    expect(put.status).toBe(409);
    expect(((await put.json()) as { error: { code: string } }).error.code).toBe("thread_running");

    const patch = await patchJson(app, `/api/threads/${thread.id}`, { mode: "plan" });
    expect(patch.status).toBe(409);
    expect(((await patch.json()) as { error: { code: string } }).error.code).toBe("thread_running");
  });
});

describe("计划回合", () => {
  it("runs read-only: the write tool is gone, the repo is untouched, and the answer becomes the document", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    await writeFile(join(repoPath, "README.md"), "# 项目\n");
    // The model narrates, tries to write anyway, then answers with the plan. In a
    // 计划 turn the write tool is not in the set at all, so the call cannot
    // execute — and only the text after it becomes the document.
    const app = makeApp(dataDir, mockModel([narrateThenToolCall(NARRATION, "call-w", "write", WRITE_INPUT), textStream(PLAN_TEXT)]));
    const thread = (await (await makeThread(app, repoPath, { mode: "plan" })).json()) as ThreadRecord;

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "给 README 加一节 Usage")] }));
    const done = await waitForStatus(app, thread.id, "idle");

    expect(await exists(join(repoPath, WRITE_INPUT.file_path))).toBe(false);
    expect(await readFile(join(repoPath, "README.md"), "utf8")).toBe("# 项目\n");
    // Nothing was approved either: a 计划 turn never parks on a write.
    expect(done.status).toBe("idle");

    // The plan is the text *after* the last tool call; the narration before it
    // is not part of the document.
    const stored = await readFile(join(dataDir, "plans", `${thread.id}.md`), "utf8");
    expect(stored).toBe(PLAN_TEXT.trim());
    expect(stored).not.toContain(NARRATION);
    // It was in the turn, though — the document is a slice of the reply, not the whole of it.
    expect(JSON.stringify(done.messages)).toContain(NARRATION);
    expect(await (await request(app, `/api/threads/${thread.id}/plan`)).json()).toMatchObject({ content: PLAN_TEXT.trim() });
  });

  it("keeps the previous document when the turn ends on a tool call with nothing after it", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    await writeFile(join(repoPath, "README.md"), "# 项目\n");
    const app = makeApp(dataDir, mockModel([toolCallStream("call-r", "read", { file_path: "README.md" }), emptyStream()]));
    const thread = (await (await makeThread(app, repoPath, { mode: "plan" })).json()) as ThreadRecord;

    // A plan the user already has. A turn that produced no closing text must not
    // replace it with an empty file.
    await putJson(app, `/api/threads/${thread.id}/plan`, { content: PLAN_TEXT });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "再看看")] }));
    await waitForStatus(app, thread.id, "idle");

    expect(await readFile(join(dataDir, "plans", `${thread.id}.md`), "utf8")).toBe(PLAN_TEXT);
  });

  it("writes no plan document for an Agent turn", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeApp(dataDir, mockModel([textStream("做完了")]));
    const thread = (await (await makeThread(app, repoPath)).json()) as ThreadRecord;

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "随便做点什么")] }));
    await waitForStatus(app, thread.id, "idle");

    expect(await exists(join(dataDir, "plans", `${thread.id}.md`))).toBe(false);
  });
});
