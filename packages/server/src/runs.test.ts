import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";
import { isToolUIPart, simulateReadableStream, type LanguageModel, type ModelMessage, type TextStreamPart, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { stripDeniedApprovalResults } from "./engines/harness-messages.js";
import { createEngineRegistry, type EngineContext, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import { createVgentEngineFactory } from "./engines/vgent.js";
import { TurnResumeFailedError } from "./errors.js";
import {
  ABANDONED_TURN_TEXT,
  AUTO_TITLE_MAX_LEN,
  closePendingToolParts,
  createRunManager,
  deriveThreadTitle,
  RESTART_PENDING_TOOL_TEXT,
  RESUME_FAILED_TEXT,
  UNEXECUTED_TOOL_TEXT,
  rawErrorText,
} from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore, DEFAULT_THREAD_TITLE } from "./store/threads.js";
import type { HarnessState, Project, ThreadMessageMetadata, ThreadRecord } from "./types.js";

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
  const dir = await mkdtemp(join(tmpdir(), "vgent-runs-"));
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

async function readSse(response: Response): Promise<{ type: string; errorText?: string }[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { type: string; errorText?: string });
}

function makeApp(dataDir: string, factory: EngineFactoryOverride, stopTimeoutMs?: number): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
    registry: createEngineRegistry({ "claude-code": factory }),
    ...(stopTimeoutMs != null ? { stopTimeoutMs } : {}),
  });
  apps.push(instance);
  return instance;
}

async function setupThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  return (await (
    await postJson(app, "/api/threads", { projectId: project.id, title: "审批", engine: "claude-code" })
  ).json()) as ThreadRecord;
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function getThread(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  return (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
}

async function waitForStatus(app: VgentApp, threadId: string, wanted: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await getThread(app, threadId);
    if (record.status === wanted) return record;
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 没有进入状态 ${wanted}: ${JSON.stringify(await getThread(app, threadId))}`);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Waits until the run slot is free. The final status write happens inside the
 * turn, a tick before the run releases its slot and parks its engine, so a test
 * that shuts the app down right after a status change would race that parking.
 * The resume endpoint answers 204 only once the slot is gone.
 */
async function waitForSlotReleased(app: VgentApp, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request(app, `/api/chat/${threadId}/stream`);
    await response.body?.cancel();
    if (response.status === 204) return;
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 的运行槽位没有释放`);
}

/** The engine writes its resume state after the run releases its slot, so the file lags the status. */
async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await exists(path)) return;
    await sleep(10);
  }
  throw new Error(`文件没有出现: ${path}`);
}

const toStream = (parts: TextStreamPart<ToolSet>[]) =>
  ReadableStream.from(
    (async function* () {
      for (const part of parts) yield part;
    })(),
  ) as ReadableStream<TextStreamPart<ToolSet>>;

const TOOL_CALL = {
  type: "tool-call" as const,
  toolCallId: "call-1",
  toolName: "bash",
  input: { command: "uname -a | wc -c" },
  providerExecuted: true,
};

/** Exactly what a permission-gated bash call looks like on the wire. */
const approvalParts = (): TextStreamPart<ToolSet>[] =>
  [
    { type: "start" },
    TOOL_CALL,
    { type: "tool-approval-request", approvalId: "ap-1", toolCall: TOOL_CALL },
  ] as unknown as TextStreamPart<ToolSet>[];

const textParts = (text: string): TextStreamPart<ToolSet>[] => [
  { type: "start" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", text },
  { type: "text-end", id: "t1" },
];

/**
 * The continuation: the approved call finally produces its output. Its chunks
 * address the tool part of the *previous* assistant message, which is what
 * makes this the regression test for rebuilding that message from a blank one.
 */
const continuationParts = (): TextStreamPart<ToolSet>[] =>
  [
    { type: "start" },
    { ...TOOL_CALL, type: "tool-result", output: { stdout: "     137" } },
    ...textParts("命令已执行").slice(1),
  ] as unknown as TextStreamPart<ToolSet>[];

/**
 * The continuation after 「拒绝」: the runtime is told the call was denied, says
 * so, and the turn ends. Nothing re-issues the call.
 */
const deniedContinuationParts = (): TextStreamPart<ToolSet>[] =>
  [
    { type: "start" },
    { type: "tool-approval-response", approvalId: "ap-1", toolCallId: TOOL_CALL.toolCallId, approved: false },
    ...textParts("好的，那我不执行这条命令").slice(1),
  ] as unknown as TextStreamPart<ToolSet>[];

interface FakeRunner extends EngineRunner {
  readonly id: number;
  readonly streams: ModelMessage[][];
  /** What the harness would have been able to collect from each `stream()` call. */
  readonly continuations: unknown[][];
}

/** What a frozen turn's payload looks like: adapter-opaque, naming a live bridge. */
const CONTINUE_FROM = {
  type: "continue-turn",
  harnessId: "fake",
  specificationVersion: "harness-v1",
  data: { bridge: { port: 51234, token: "bridge-token" } },
};

/**
 * A runner that asks for approval on any prompt containing 「工具」 and answers
 * with plain text otherwise. It reports an unfinished turn exactly while an
 * approval is outstanding, like the real harness session does.
 *
 * `suspend` picks what a stateful engine does on a graceful shutdown: freeze
 * the parked turn (`"ok"`), fail to (`"fail"`), or not support it at all
 * (omitted, which is what the Codex runner looks like).
 */
function createApprovalEngine(options: { suspend?: "ok" | "fail" } = {}) {
  const runners: FakeRunner[] = [];
  const created: EngineContext[] = [];
  const finished: number[] = [];
  const destroyed: number[] = [];
  const suspended: number[] = [];

  const factory: EngineFactoryOverride = {
    async create(ctx) {
      created.push(ctx);
      const id = runners.length + 1;
      const streams: ModelMessage[][] = [];
      const continuations: unknown[][] = [];
      let unfinished = false;
      const runner: FakeRunner = {
        id,
        streams,
        continuations,
        hasUnfinishedTurn: () => unfinished,
        async stream({ messages }) {
          streams.push(messages);
          // The real harness runner sanitizes the history before the harness
          // collects continuations from it; mirroring that here is what makes
          // a denied approval visible to this fake at all.
          const collected = collectHarnessAgentToolApprovalContinuations({ messages: stripDeniedApprovalResults(messages) });
          continuations.push(collected);
          const last = messages.at(-1);
          if (last?.role === "tool") {
            unfinished = false;
            const denied = collected.some((part) => part.approved === false);
            return { stream: toStream(denied ? deniedContinuationParts() : continuationParts()) };
          }
          const wantsTool = JSON.stringify(last).includes("工具");
          unfinished = wantsTool;
          return { stream: toStream(wantsTool ? approvalParts() : textParts("普通回答")) };
        },
        async finish() {
          finished.push(id);
          await ctx.saveHarnessState({
            version: 1,
            sessionId: ctx.thread.id,
            resumeFrom: { harnessId: "fake", specificationVersion: 1, data: { runner: id } },
            updatedAt: new Date().toISOString(),
          } as unknown as HarnessState);
        },
        async destroy() {
          destroyed.push(id);
        },
        ...(options.suspend == null
          ? {}
          : {
              async suspend() {
                suspended.push(id);
                if (options.suspend === "fail") throw new Error("桥接进程已经不在了");
                return {
                  version: 1,
                  sessionId: ctx.thread.id,
                  continueFrom: CONTINUE_FROM,
                  updatedAt: new Date().toISOString(),
                } as unknown as HarnessState;
              },
            }),
      };
      runners.push(runner);
      return runner;
    },
  };

  return { factory, runners, created, finished, destroyed, suspended };
}

/** Flip a pending approval part to what `useChat`'s `addToolApprovalResponse` produces. */
function respond(message: UIMessage, approved: boolean): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolUIPart(part) && part.state === "approval-requested"
        ? { ...part, state: "approval-responded", approval: { ...part.approval, approved } }
        : part,
    ),
  } as UIMessage;
}

const approve = (message: UIMessage): UIMessage => respond(message, true);

/** Seed a thread's stored history directly; `POST /api/chat` only ever appends its own tail. */
async function seedHistory(dataDir: string, threadId: string, messages: UIMessage[]): Promise<void> {
  const path = join(dataDir, "threads", `${threadId}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as ThreadRecord;
  await writeFile(path, JSON.stringify({ ...record, messages }));
}

describe("approval parking", () => {
  it("keeps the engine alive across an approval and only finishes it once the turn ends", async () => {
    const dir = await tempDir();
    const engine = createApprovalEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, dir);
    const harnessPath = join(dir, "threads", `${thread.id}.harness.json`);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下 uname")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    // The engine is parked, not stopped: no `finish()`, and no resume state on
    // disk that would point at a bridge that is already dead.
    expect(engine.finished).toEqual([]);
    expect(engine.destroyed).toEqual([]);
    expect(await exists(harnessPath)).toBe(false);
    expect(parked.messages.at(-1)?.parts.some((part) => isToolUIPart(part) && part.state === "approval-requested")).toBe(true);

    const approved = approve(parked.messages.at(-1)!);
    const second = await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), approved] });
    expect(second.status).toBe(200);
    await readSse(second);
    const done = await waitForStatus(app, thread.id, "idle");
    await waitForFile(harnessPath);

    // Same runner instance both times — the continuation ran on the live session.
    expect(engine.runners).toHaveLength(1);
    expect(engine.runners[0]?.streams).toHaveLength(2);
    expect(engine.runners[0]?.streams[1]?.at(-1)?.role).toBe("tool");
    expect(engine.finished).toEqual([1]);
    // The continued message is rebuilt on top of the one the client sent back,
    // so the approved call carries its output instead of being dropped.
    expect(done.messages).toHaveLength(2);
    const tool = done.messages.at(-1)?.parts.find(isToolUIPart);
    expect(tool?.state).toBe("output-available");
    expect(tool).toMatchObject({ output: { stdout: "     137" } });
    expect(JSON.stringify(done.messages)).toContain("命令已执行");
  });

  /**
   * Regression: 「拒绝」 used to leave the thread 「进行中」 forever. The denial
   * reached the run manager fine, but `convertToModelMessages` pairs it with a
   * synthetic `execution-denied` result that made the harness skip the approval
   * response — so nothing ever answered the runtime and the stream never ended.
   * See `stripDeniedApprovalResults`.
   */
  it("ends the turn on its own when the approval is denied", async () => {
    const dir = await tempDir();
    const engine = createApprovalEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下 uname")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    const denied = respond(parked.messages.at(-1)!, false);
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), denied] }));
    const done = await waitForStatus(app, thread.id, "idle");
    // `finish()` runs after the status write; the harness file is its receipt.
    await waitForFile(join(dir, "threads", `${thread.id}.harness.json`));

    // The denial reached the engine as an approval continuation — the thing the
    // synthetic result used to swallow.
    expect(engine.runners).toHaveLength(1);
    expect(engine.runners[0]?.continuations[1]).toMatchObject([{ type: "tool-approval-response", approvalId: "ap-1", approved: false }]);
    // Same session, continued in place, then closed for real.
    expect(engine.runners[0]?.streams).toHaveLength(2);
    expect(engine.finished).toEqual([1]);
    expect(engine.destroyed).toEqual([]);
    // And the turn really is over: no pending approval left, and the reply is there.
    expect(done.messages.some((message) => message.parts.some((part) => isToolUIPart(part) && part.state === "approval-requested"))).toBe(
      false,
    );
    expect(JSON.stringify(done.messages)).toContain("好的，那我不执行这条命令");
  });

  it("destroys the parked engine when a new prompt arrives and restarts from the last finished state", async () => {
    const dir = await tempDir();
    const engine = createApprovalEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, dir);

    // A finished turn first, so there is a resume state to fall back to.
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "先随便聊聊")] }));
    const afterFirst = await waitForStatus(app, thread.id, "idle");

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...afterFirst.messages, userMessage("u2", "用工具跑一下")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages, userMessage("u3", "算了，换个问题")] }));
    const after = await waitForStatus(app, thread.id, "idle");

    expect(engine.destroyed).toEqual([2]);
    expect(engine.runners).toHaveLength(3);
    // The fresh runner resumed from runner 1 — the last turn that really finished.
    expect(engine.created[2]?.harnessState?.resumeFrom).toMatchObject({ data: { runner: 1 } });
    // And the abandoned approval is closed in the stored history.
    const abandoned = after.messages.find((message) =>
      message.parts.some((part) => isToolUIPart(part) && part.state === "output-error" && part.errorText === ABANDONED_TURN_TEXT),
    );
    expect(abandoned).toBeDefined();
    expect(after.messages.some((message) => message.parts.some((part) => isToolUIPart(part) && part.state === "approval-requested"))).toBe(
      false,
    );
  });

  it("closes an `awaiting-*` thread on startup, because its turn died with the process", async () => {
    const dir = await tempDir();
    const threads = createThreadStore(dir);
    const record = await threads.create({ projectId: "p1", engine: "claude-code" });
    await threads.update(record.id, {
      status: "awaiting-approval",
      messages: [
        userMessage("u1", "跑个命令"),
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "tool-bash", toolCallId: "call-1", state: "approval-requested", input: {}, approval: { id: "ap-1" } }],
        } as unknown as UIMessage,
      ],
    });

    const engine = createApprovalEngine();
    const app = makeApp(dir, engine.factory);
    const recovered = await waitForStatus(app, record.id, "interrupted");
    const part = recovered.messages.at(-1)?.parts.find(isToolUIPart);
    expect(part?.state).toBe("output-error");
    expect((part as { errorText?: string }).errorText).toBe(RESTART_PENDING_TOOL_TEXT);
  });

  it("keeps a dynamic tool's name when closing it, so the client can still render the step", () => {
    const [message] = closePendingToolParts(
      [
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "cua__launch_app",
              toolCallId: "call-1",
              state: "approval-requested",
              input: { bundle_id: "com.apple.Safari" },
              providerExecuted: false,
              approval: { id: "ap-1" },
            },
          ],
        },
      ],
      RESTART_PENDING_TOOL_TEXT,
    );
    expect(message?.parts[0]).toEqual({
      type: "dynamic-tool",
      toolName: "cua__launch_app",
      toolCallId: "call-1",
      state: "output-error",
      input: { bundle_id: "com.apple.Safari" },
      providerExecuted: false,
      errorText: RESTART_PENDING_TOOL_TEXT,
    });
  });

  /**
   * Regression: the history a long-lived thread accumulates must not change
   * what the continuation looks like to the harness. `convertToModelMessages`
   * drops assistant messages with no parts and turns closed tool parts into
   * plain results, so the only `tool-approval-request` left is the pending one
   * — which is what `collectHarnessAgentToolApprovalContinuations` matches the
   * response against.
   */
  it("keeps the continuation clean on a history with an empty turn and a closed tool call", async () => {
    const dir = await tempDir();
    const engine = createApprovalEngine();
    const app = makeApp(dir, engine.factory);
    const thread = await setupThread(app, dir);

    const history: UIMessage[] = [
      userMessage("u0", "在根目录新建 SMOKE.txt"),
      {
        id: "a0",
        role: "assistant",
        parts: [
          { type: "tool-write", toolCallId: "call-0", state: "output-error", input: { path: "SMOKE.txt" }, errorText: "hook 拦了" },
          { type: "text", state: "done", text: "写文件被拦了" },
        ],
      } as unknown as UIMessage,
      // A turn that produced nothing renderable — what the server used to store
      // for an errored turn, and what any older thread still carries.
      { id: "a1", role: "assistant", parts: [] },
      userMessage("u1", "用工具跑一下 uname"),
    ];
    await seedHistory(dir, thread.id, history);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: history }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    const approved = approve(parked.messages.at(-1)!);
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), approved] }));
    await waitForStatus(app, thread.id, "idle");

    const continuation = engine.runners[0]?.streams[1];
    expect(continuation).toBeDefined();
    const empty = continuation!.filter((message) => Array.isArray(message.content) && message.content.length === 0);
    expect(empty).toEqual([]);
    expect(continuation!.at(-1)?.role).toBe("tool");
    expect(continuation!.at(-1)?.content).toMatchObject([{ type: "tool-approval-response", approvalId: "ap-1", approved: true }]);
    // The closed `write` call is a tool result, not a second pending approval.
    const requests = continuation!
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((part) => part.type === "tool-approval-request");
    expect(requests).toHaveLength(1);
    // And the harness resolves the response against it instead of throwing.
    expect(collectHarnessAgentToolApprovalContinuations({ messages: continuation! })).toMatchObject([
      { type: "tool-approval-response", approvalId: "ap-1", approved: true },
    ]);
  });

  /**
   * What a real Claude Code step looks like when two calls go out together and
   * the first one needs an approval: the harness pauses mid-step, so the second
   * call is left with nothing but its `tool-input-start`.
   */
  const EDIT_CALL = {
    type: "tool-call" as const,
    toolCallId: "call-edit",
    toolName: "edit",
    input: { path: "a.ts" },
    providerExecuted: true,
  };
  const WRITE_CALL = {
    type: "tool-call" as const,
    toolCallId: "call-write",
    toolName: "write",
    input: { path: "b.ts" },
    providerExecuted: true,
  };
  const writeInputStart = { type: "tool-input-start", id: "call-write", toolName: "write", providerExecuted: true };

  const pausedStepParts = (): TextStreamPart<ToolSet>[] =>
    [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", id: "call-edit", toolName: "edit", providerExecuted: true },
      EDIT_CALL,
      { type: "tool-approval-request", approvalId: "ap-edit", toolCall: EDIT_CALL },
      // The harness paused here: this call never got past its input.
      writeInputStart,
    ] as unknown as TextStreamPart<ToolSet>[];

  /** The approved continuation: a new step that re-issues `write` from the top. */
  const approvedStepParts = (): TextStreamPart<ToolSet>[] =>
    [
      { type: "start" },
      { type: "start-step" },
      { ...EDIT_CALL, type: "tool-result", output: { ok: true } },
      writeInputStart,
      WRITE_CALL,
      { ...WRITE_CALL, type: "tool-result", output: { written: true } },
      ...textParts("两个文件都改好了").slice(1),
    ] as unknown as TextStreamPart<ToolSet>[];

  /** The denied continuation: the engine gives up without re-issuing `write`. */
  const deniedStepParts = (): TextStreamPart<ToolSet>[] =>
    [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-output-denied", toolCallId: "call-edit" },
      ...textParts("好的，不改了").slice(1),
    ] as unknown as TextStreamPart<ToolSet>[];

  /** Pauses on the first turn, then plays `continuation` once the human answers. */
  function createPausedStepEngine(continuation: () => TextStreamPart<ToolSet>[]): EngineFactoryOverride {
    return {
      async create() {
        let unfinished = false;
        return {
          hasUnfinishedTurn: () => unfinished,
          async stream({ messages }) {
            if (messages.at(-1)?.role === "tool") {
              unfinished = false;
              return { stream: toStream(continuation()) };
            }
            unfinished = true;
            return { stream: toStream(pausedStepParts()) };
          },
          async finish() {},
          async destroy() {},
        } satisfies EngineRunner;
      },
    };
  }

  const partsOf = (message: UIMessage | undefined, toolCallId: string) =>
    (message?.parts ?? []).filter(isToolUIPart).filter((part) => part.toolCallId === toolCallId);

  /** Drive a paused step through its approval answer and return both records. */
  async function runPausedStep(
    continuation: () => TextStreamPart<ToolSet>[],
    approved: boolean,
  ): Promise<{ parked: ThreadRecord; done: ThreadRecord; chunks: { type: string }[] }> {
    const dir = await tempDir();
    const app = makeApp(dir, createPausedStepEngine(continuation));
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "改两个文件")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    const answered = respond(parked.messages.at(-1)!, approved);
    const chunks = await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), answered] }));
    const done = await waitForStatus(app, thread.id, "idle");
    return { parked, done, chunks };
  }

  it("keeps a half-streamed call open while the turn is parked", async () => {
    const { parked } = await runPausedStep(approvedStepParts, true);
    const write = partsOf(parked.messages.at(-1), "call-write");
    expect(write).toHaveLength(1);
    expect(write[0]?.state).toBe("input-streaming");
  });

  it("does not duplicate a call the continuation re-issues in a new step", async () => {
    const { done, chunks } = await runPausedStep(approvedStepParts, true);
    const write = partsOf(done.messages.at(-1), "call-write");
    expect(write).toHaveLength(1);
    expect(write[0]?.state).toBe("output-available");
    expect(write[0]).toMatchObject({ output: { written: true } });
    expect(partsOf(done.messages.at(-1), "call-edit")).toHaveLength(1);
    // The client-facing stream is untouched: the seed fix only changes what the
    // server rebuilds from it.
    expect(chunks.map((chunk) => chunk.type)).toEqual(
      expect.arrayContaining(["start-step", "tool-input-start", "tool-input-available", "tool-output-available"]),
    );
  });

  it("closes a call the denied turn never ran", async () => {
    const { done } = await runPausedStep(deniedStepParts, false);
    expect(done.status).toBe("idle");
    const write = partsOf(done.messages.at(-1), "call-write");
    expect(write).toHaveLength(1);
    expect(write[0]?.state).toBe("output-error");
    expect((write[0] as { errorText?: string }).errorText).toBe(UNEXECUTED_TOOL_TEXT);
    expect(partsOf(done.messages.at(-1), "call-edit")[0]?.state).toBe("output-denied");
  });

  /**
   * The graceful-restart path: a stateful engine that can freeze its parked
   * turn leaves the thread waiting instead of interrupting it, and the next
   * process picks the turn up from `continueFrom`.
   */
  describe("suspending a parked turn across a graceful restart", () => {
    /** Runs a turn up to its approval and shuts the app down the way SIGTERM does. */
    async function parkThenShutdown(dir: string, engine: ReturnType<typeof createApprovalEngine>): Promise<ThreadRecord> {
      const app = makeApp(dir, engine.factory);
      const thread = await setupThread(app, dir);
      await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下 uname")] }));
      const parked = await waitForStatus(app, thread.id, "awaiting-approval");
      await waitForSlotReleased(app, thread.id);
      await app.shutdown();
      return parked;
    }

    const readHarnessState = async (dir: string, threadId: string): Promise<HarnessState> =>
      JSON.parse(await readFile(join(dir, "threads", `${threadId}.harness.json`), "utf8")) as HarnessState;

    it("persists `continueFrom`, leaves the thread waiting, and continues the turn in the next process", async () => {
      const dir = await tempDir();
      const first = createApprovalEngine({ suspend: "ok" });
      const parked = await parkThenShutdown(dir, first);

      expect(first.suspended).toEqual([1]);
      // Frozen, not torn down: the bridge is what the next process attaches to.
      expect(first.destroyed).toEqual([]);
      expect(first.finished).toEqual([]);
      expect((await readHarnessState(dir, parked.id)).continueFrom).toMatchObject(CONTINUE_FROM);

      // A brand new app over the same data dir is what a restart looks like:
      // the recovery pass must leave the waiting thread and its open call alone.
      const second = createApprovalEngine({ suspend: "ok" });
      const app = makeApp(dir, second.factory);
      const restored = await getThread(app, parked.id);
      expect(restored.status).toBe("awaiting-approval");
      expect(restored.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("approval-requested");

      const approved = approve(restored.messages.at(-1)!);
      await readSse(await postJson(app, `/api/chat/${parked.id}`, { messages: [...restored.messages.slice(0, -1), approved] }));
      const done = await waitForStatus(app, parked.id, "idle");

      // The fresh runner was handed the frozen turn, and knew it was continuing it.
      expect(second.created).toHaveLength(1);
      expect(second.created[0]?.continuesTurn).toBe(true);
      expect(second.created[0]?.harnessState?.continueFrom).toMatchObject(CONTINUE_FROM);
      expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-available");
      // And the finished turn dropped the continuation: nothing points at a
      // bridge that is now gone. (`finish()` writes after the slot is released,
      // so the file lags the status, as everywhere else in these tests.)
      let after = await readHarnessState(dir, parked.id);
      for (let attempt = 0; attempt < 200 && after.resumeFrom == null; attempt++) {
        await sleep(10);
        after = await readHarnessState(dir, parked.id);
      }
      expect(after.resumeFrom).toMatchObject({ data: { runner: 1 } });
      expect(after.continueFrom).toBeUndefined();
    });

    it("falls back to the interrupted path when suspending fails", async () => {
      const dir = await tempDir();
      const engine = createApprovalEngine({ suspend: "fail" });
      const parked = await parkThenShutdown(dir, engine);

      expect(engine.suspended).toEqual([1]);
      expect(engine.destroyed).toEqual([1]);

      const app = makeApp(dir, createApprovalEngine({ suspend: "ok" }).factory);
      const restored = await getThread(app, parked.id);
      expect(restored.status).toBe("interrupted");
      const part = restored.messages.at(-1)?.parts.find(isToolUIPart);
      expect(part?.state).toBe("output-error");
      expect((part as { errorText?: string }).errorText).toBe(RESTART_PENDING_TOOL_TEXT);
      expect(await exists(join(dir, "threads", `${parked.id}.harness.json`))).toBe(false);
    });

    it("interrupts the thread when the next process cannot attach to the frozen turn", async () => {
      const dir = await tempDir();
      const parked = await parkThenShutdown(dir, createApprovalEngine({ suspend: "ok" }));

      // The bridge died with the machine: `create` rejects for the attaching turn.
      const attempted: EngineContext[] = [];
      const app = makeApp(dir, {
        async create(ctx) {
          attempted.push(ctx);
          throw new TurnResumeFailedError(RESUME_FAILED_TEXT);
        },
      });
      const restored = await getThread(app, parked.id);
      expect(restored.status).toBe("awaiting-approval");

      const approved = approve(restored.messages.at(-1)!);
      const chunks = await readSse(await postJson(app, `/api/chat/${parked.id}`, { messages: [...restored.messages.slice(0, -1), approved] }));
      expect(chunks.find((chunk) => chunk.type === "error")?.errorText).toBe(RESUME_FAILED_TEXT);

      const after = await waitForStatus(app, parked.id, "interrupted");
      expect(attempted[0]?.harnessState?.continueFrom).toMatchObject(CONTINUE_FROM);
      // The turn is closed out, so the client stops offering to answer it, and
      // the dead continuation is gone from disk.
      const part = after.messages.at(-1)?.parts.find(isToolUIPart);
      expect(part?.state).toBe("output-error");
      expect((part as { errorText?: string }).errorText).toBe(RESUME_FAILED_TEXT);
      expect((await readHarnessState(dir, parked.id)).continueFrom).toBeUndefined();
    });

    it("still interrupts a parked turn when the engine cannot freeze it at all", async () => {
      const dir = await tempDir();
      const engine = createApprovalEngine();
      const parked = await parkThenShutdown(dir, engine);

      expect(engine.destroyed).toEqual([1]);
      const app = makeApp(dir, createApprovalEngine().factory);
      expect((await getThread(app, parked.id)).status).toBe("interrupted");
    });
  });

  it("never stores an assistant message with no parts", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          // A turn that dies before producing anything renderable.
          async stream() {
            return { stream: toStream([{ type: "start" }] as unknown as TextStreamPart<ToolSet>[]) };
          },
          async finish() {},
          async destroy() {},
        };
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] }));
    const done = await waitForStatus(app, thread.id, "idle");
    expect(done.messages.map((message) => message.role)).toEqual(["user"]);
  });

});

describe("rawErrorText", () => {
  it("says what is at the bottom of the cause chain when the message itself does not", () => {
    const dropped = new Error("Failed to process successful response", { cause: new TypeError("terminated", { cause: new Error("other side closed") }) });
    expect(rawErrorText(dropped)).toBe("Failed to process successful response（other side closed）");
    expect(rawErrorText(new Error("HTTP 401"))).toBe("HTTP 401");
    expect(rawErrorText(new Error("fetch failed: ECONNRESET", { cause: new Error("ECONNRESET") }))).toBe("fetch failed: ECONNRESET");
    expect(rawErrorText("plain")).toBe("plain");
  });
});

describe("run lifecycle", () => {
  it("ends the thread in `error` when the engine stream carries an error part", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return {
              stream: toStream([
                { type: "start" },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", text: "开始" },
                { type: "error", error: new Error("HTTP 401: authentication_failed") },
              ]),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    const chunks = await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "写个文件")] }));
    const errorChunk = chunks.find((chunk) => chunk.type === "error");
    expect(errorChunk?.errorText).toBeTruthy();
    // Client-safe by default: a plain `Error` (not a `HarnessError`) is masked.
    expect(errorChunk?.errorText).toBe("An error occurred.");

    const record = await waitForStatus(app, thread.id, "error");
    // The thread record is local single-user data, so it keeps the raw message
    // for debugging even though the SSE stream only saw the masked text.
    expect(record.error).toBe("HTTP 401: authentication_failed");
    expect(record.error).not.toBe(errorChunk?.errorText);
    // The partial assistant message is kept as built.
    expect(JSON.stringify(record.messages)).toContain("开始");
  });

  it("keeps a failed turn's error under its own message after the next turn clears the thread's", async () => {
    const dir = await tempDir();
    let calls = 0;
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            calls += 1;
            return {
              stream: toStream(
                calls === 1
                  ? [{ type: "start" }, { type: "error", error: new Error("Connect Timeout Error") }]
                  : [
                      { type: "start" },
                      { type: "text-start", id: "t1" },
                      { type: "text-delta", id: "t1", text: "好了" },
                      { type: "text-end", id: "t1" },
                    ],
              ),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "发 debug")] }));
    const failed = await waitForStatus(app, thread.id, "error");
    expect(failed.messages.map((message) => message.role)).toEqual(["user"]);
    expect(failed.messages[0]!.metadata).toMatchObject({ turnEnd: { status: "error", reason: "Connect Timeout Error" } });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...failed.messages, userMessage("u2", "再发一次")] }));
    const record = await waitForStatus(app, thread.id, "idle");
    expect(record.error).toBeUndefined();
    expect(record.messages[0]!.metadata).toMatchObject({ turnEnd: { status: "error", reason: "Connect Timeout Error" } });
    expect((record.messages[1]!.metadata as { turnEnd?: unknown } | undefined)?.turnEnd).toBeUndefined();
  });

  it("keeps a failed tool call out of the thread's error, with the tool's own text on the call", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return {
              stream: toStream([
                { type: "start" },
                { type: "tool-call", toolCallId: "c1", toolName: "read", input: { file_path: "nope.svg" } },
                { type: "tool-error", toolCallId: "c1", toolName: "read", input: { file_path: "nope.svg" }, error: new Error("File not found: nope.svg") },
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", text: "没有这个文件" },
                { type: "text-end", id: "t1" },
              ]),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "读一下")] }));
    const record = await waitForStatus(app, thread.id, "idle");
    expect(record.error).toBeUndefined();
    expect(JSON.stringify(record.messages)).toContain("File not found: nope.svg");
    expect(JSON.stringify(record.messages)).not.toContain("An error occurred.");
  });

  it("stores a tool called with no arguments with an empty input, so the history stays valid", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return {
              stream: toStream([
                { type: "start" },
                // What Claude Code's ListAgents came back as: no `input` key at all.
                { type: "tool-call", toolCallId: "c1", toolName: "ListAgents", input: undefined, providerExecuted: true, dynamic: true },
                { type: "tool-result", toolCallId: "c1", toolName: "ListAgents", input: undefined, output: { listing: "none" }, providerExecuted: true, dynamic: true },
              ] as unknown as TextStreamPart<ToolSet>[]),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "谁在线")] }));
    const record = await waitForStatus(app, thread.id, "idle");
    const call = record.messages[1]?.parts.find(isToolUIPart);
    expect(call?.state).toBe("output-available");
    expect(call?.input).toEqual({});

    // The next message carries that history back and is accepted.
    await waitForSlotReleased(app, thread.id);
    const next = await postJson(app, `/api/chat/${thread.id}`, { messages: [...record.messages, userMessage("u2", "好了？")] });
    expect(next.status).toBe(200);
    await readSse(next);
  });

  it("takes a history an older build stored without a tool input, and repairs the stored copy", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return { stream: toStream([{ type: "start" }, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", text: "好了" }, { type: "text-end", id: "t1" }]) };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);
    const broken = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-ListAgents", toolCallId: "c1", state: "output-available", output: { listing: "none" }, providerExecuted: true }],
    } as unknown as UIMessage;

    await createThreadStore(dir).saveMessages(thread.id, [userMessage("u1", "谁在线"), broken]);

    const response = await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "谁在线"), broken, userMessage("u2", "好了？")] });
    expect(response.status).toBe(200);
    await readSse(response);
    const record = await waitForStatus(app, thread.id, "idle");
    expect(record.messages.map((message) => message.id).slice(0, 3)).toEqual(["u1", "a1", "u2"]);
    expect(record.messages[1]?.parts.find(isToolUIPart)?.input).toEqual({});
  });

  it("says which part of a malformed history broke, instead of echoing the history", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, {
      async create() {
        throw new Error("never started");
      },
    });
    const thread = await setupThread(app, dir);
    const broken = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "text", text: "前一段" }, { type: "tool-read", toolCallId: "c1", state: "sideways", input: {} }],
    } as unknown as UIMessage;

    const response = await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "读一下"), broken, userMessage("u2", "再来")] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_messages");
    expect(body.error.message).toBe("消息格式不合法：第 2 条消息的 tool-read 一步");
  });

  it("releases the slot when a stopped engine ignores its abort signal", async () => {
    const dir = await tempDir();
    let release = () => {};
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return {
              stream: new ReadableStream<TextStreamPart<ToolSet>>({
                start(controller) {
                  controller.enqueue({ type: "start" });
                  // Deliberately never closed until the test lets it go.
                  release = () => controller.close();
                },
              }),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory, 100);
    const thread = await setupThread(app, dir);

    const post = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "跑个久的")] });
    for (let attempt = 0; attempt < 100 && (await request(app, `/api/chat/${thread.id}/stream`)).status !== 200; attempt++) {
      await sleep(10);
    }

    const started = Date.now();
    expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(3000);
    // Slot forced open: no live run is left holding the thread.
    expect((await request(app, `/api/chat/${thread.id}/stream`)).status).toBe(204);
    expect((await getThread(app, thread.id)).status).toBe("interrupted");

    release();
    await readSse(await post);
  });

  it("serves the replay stream while a finished run is still persisting", async () => {
    const dir = await tempDir();
    const threads = createThreadStore(dir);
    const projects = createProjectStore(dir);
    const project = await projects.create({ repoPath: dir });
    const thread = await threads.create({ projectId: project.id, engine: "claude-code" });

    let hold: (() => void) | undefined;
    const gated = {
      ...threads,
      update: async (id: string, patch: Parameters<typeof threads.update>[1]) => {
        if (patch.status === "idle" && hold == null) {
          await new Promise<void>((resolve) => {
            hold = resolve;
          });
        }
        return threads.update(id, patch);
      },
    };

    const engine = createApprovalEngine();
    const runs = createRunManager({
      threads: gated,
      projects,
      settings: createSettingsStore(dir),
      registry: createEngineRegistry({ "claude-code": engine.factory }),
      dataDir: dir,
    });
    const hub = await runs.start(thread.id, [userMessage("u1", "你好")]);
    for await (const _chunk of hub.subscribe()) {
      // drain until the hub closes, which is exactly the finalizing window
    }

    expect(hub.closed).toBe(true);
    const replay = runs.subscribe(thread.id);
    expect(replay).toBeDefined();
    const replayed: unknown[] = [];
    for await (const chunk of replay!) replayed.push(chunk);
    expect(replayed.length).toBeGreaterThan(0);

    for (let attempt = 0; attempt < 100 && hold == null; attempt++) await sleep(10);
    hold?.();
    await runs.stopAll();
    // Once the run entry is gone there is nothing to subscribe to.
    for (let attempt = 0; attempt < 100 && runs.subscribe(thread.id) != null; attempt++) await sleep(10);
    expect(runs.subscribe(thread.id)).toBeUndefined();
  });

  it("续发等待上一轮落盘后使用最新历史", async () => {
    const dir = await tempDir();
    const threads = createThreadStore(dir);
    const projects = createProjectStore(dir);
    const project = await projects.create({ repoPath: dir });
    const thread = await threads.create({ projectId: project.id, engine: "claude-code" });
    let releaseFinal!: () => void;
    let finalizing!: () => void;
    let captured!: () => void;
    const atFinal = new Promise<void>((resolve) => { finalizing = resolve; });
    const atCapture = new Promise<void>((resolve) => { captured = resolve; });
    const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
    let captureNextRead = false;
    const gated = {
      ...threads,
      async get(id: string) {
        const record = await threads.get(id);
        if (captureNextRead) {
          captureNextRead = false;
          captured();
        }
        return record;
      },
      // A failed interim save must not let a fast follow-up drop the final reply.
      async saveMessages() {},
      async update(id: string, patch: Parameters<typeof threads.update>[1]) {
        if (patch.status === "idle" && (await threads.get(id))?.messages.length === 1) {
          finalizing();
          await finalGate;
        }
        return threads.update(id, patch);
      },
    };
    const engine = createApprovalEngine();
    const runs = createRunManager({
      threads: gated,
      projects,
      settings: createSettingsStore(dir),
      registry: createEngineRegistry({ "claude-code": engine.factory }),
      dataDir: dir,
    });
    const first = await runs.start(thread.id, [userMessage("u1", "第一轮")]);
    for await (const _chunk of first.subscribe()) {}
    await atFinal;

    captureNextRead = true;
    const next = runs.start(thread.id, [userMessage("u2", "续发")]);
    // The old startup reads before the final write; the repaired startup
    // waits for that write and therefore has no read to signal yet.
    await Promise.race([atCapture, sleep(50)]);
    releaseFinal();
    const second = await next;
    for await (const _chunk of second.subscribe()) {}
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await threads.get(thread.id);
      if (current?.status === "idle" && current.messages.length >= 3) break;
      await sleep(10);
    }

    const record = await threads.get(thread.id);
    expect(record?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    await runs.stopAll();
  });
});

/**
 * The in-house engine driven through the *real* `createVgentEngineFactory`,
 * with only its model replaced. Everything else — the `ToolLoopAgent`, the
 * permission mapping, the real `write` tool — is the production path.
 */
describe("vgent engine", () => {
  const NO_USAGE = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, reasoning: undefined },
    totalTokens: undefined,
  };

  /** One `doStream` result: a single tool call, streamed the way a provider does it. */
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

  /** One `doStream` result: plain text, then stop. */
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

  /** `textStream`, but with token counts the way a real provider reports them. */
  const textStreamWithUsage = (text: string, usage: unknown) => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: { unified: "stop" }, usage },
      ],
    }),
  });

  const mockModel = (results: unknown[]): LanguageModel =>
    new MockLanguageModelV3({ doStream: results as never }) as unknown as LanguageModel;

  const WRITE_INPUT = { file_path: "SMOKE.txt", content: "写好了\n" };

  function makeVgentApp(dataDir: string, model: LanguageModel): VgentApp {
    const instance = createApp({
      dataDir,
      token: TOKEN,
      registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model }) }),
    });
    apps.push(instance);
    return instance;
  }

  /**
   * 运行模式 is global and now defaults to 自动改文件, so the approval tests set
   * 询问 explicitly rather than leaning on a default that has moved once.
   */
  async function setupVgentThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
    const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ runMode: "allow-reads" }) });
    return (await (
      await postJson(app, "/api/threads", { projectId: project.id, title: "自研引擎", engine: "vgent" })
    ).json()) as ThreadRecord;
  }

  it("persists the turn's token usage as the assistant message's metadata", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeVgentApp(
      dataDir,
      mockModel([
        textStreamWithUsage("算好了", {
          inputTokens: { total: 1234, noCache: 234, cacheRead: 1000, cacheWrite: 0 },
          outputTokens: { total: 56, reasoning: 8 },
          totalTokens: 1290,
        }),
      ]),
    );
    const thread = await setupVgentThread(app, repoPath);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "数一数")] }));
    const done = await waitForStatus(app, thread.id, "idle");

    const metadata = done.messages.at(-1)?.metadata as ThreadMessageMetadata | undefined;
    expect(typeof metadata?.usage?.inputTokens).toBe("number");
    // `inputTokens` is the whole prompt, cache reads included — the context size.
    expect(metadata?.usage).toMatchObject({ inputTokens: 1234, outputTokens: 56, cachedInputTokens: 1000, reasoningTokens: 8 });
    expect(metadata?.totalUsage).toMatchObject({ totalTokens: 1290 });
  });

  it("parks on a write approval in allow-reads and writes the file once it is approved", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeVgentApp(dataDir, mockModel([toolCallStream("call-w", "write", WRITE_INPUT), textStream("文件已写入")]));
    const thread = await setupVgentThread(app, repoPath);
    const written = join(repoPath, "SMOKE.txt");

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "在根目录新建 SMOKE.txt")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    // Approval is pending, so the tool has not run and nothing is on disk.
    expect(await exists(written)).toBe(false);
    const pending = parked.messages.at(-1)?.parts.find(isToolUIPart);
    expect(pending?.state).toBe("approval-requested");
    // A stateless engine has no resume state, so `finish()` must not write one.
    expect(await exists(join(dataDir, "threads", `${thread.id}.harness.json`))).toBe(false);

    const approved = approve(parked.messages.at(-1)!);
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), approved] }));
    const done = await waitForStatus(app, thread.id, "idle");

    expect(await readFile(written, "utf8")).toBe(WRITE_INPUT.content);
    expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-available");
    expect(JSON.stringify(done.messages)).toContain("文件已写入");
    expect(await exists(join(dataDir, "threads", `${thread.id}.harness.json`))).toBe(false);
  });

  it("never asks about a tool on the global allowlist, even in 询问", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeVgentApp(dataDir, mockModel([toolCallStream("call-w", "write", WRITE_INPUT), textStream("文件已写入")]));
    const thread = await setupVgentThread(app, repoPath);
    const written = join(repoPath, "SMOKE.txt");

    // What 「一直允许」 on an approval card writes; the run mode stays 询问.
    await postJson(app, "/api/settings/allowlist", { tool: "write" });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "在根目录新建 SMOKE.txt")] }));
    const done = await waitForStatus(app, thread.id, "idle");

    expect(await readFile(written, "utf8")).toBe(WRITE_INPUT.content);
    expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-available");
  });

  /**
   * 「一直允许」 down to the sub-command, through the whole server path. A
   * settings file written before the change holds `bash(git)`, which used to
   * wave `git push` through; it must now park on approval. The entry the card
   * writes today, `bash(git show)`, still answers its own command.
   */
  it("stops honouring a legacy bash(git) entry, and honours the sub-command one", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeVgentApp(dataDir, mockModel([toolCallStream("call-b", "bash", { command: "git push" }), textStream("没推")]));
    const thread = await setupVgentThread(app, repoPath);
    // 自动改文件 is the default run mode now; shell commands still ask in it.
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ runMode: "allow-edits" }) });
    await postJson(app, "/api/settings/allowlist", { tool: "bash(git)" });

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "推一下分支")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    const pending = parked.messages.at(-1)?.parts.find(isToolUIPart);
    expect(pending?.state).toBe("approval-requested");
    expect(pending?.input).toMatchObject({ command: "git push" });

    // A read-only sub-command the list does name runs without asking, even in 询问.
    const other = makeVgentApp(await tempDir(), mockModel([toolCallStream("call-s", "bash", { command: "git show" }), textStream("看过了")]));
    const readThread = await setupVgentThread(other, repoPath);
    await postJson(other, "/api/settings/allowlist", { tool: "bash(git show)" });

    await readSse(await postJson(other, `/api/chat/${readThread.id}`, { messages: [userMessage("u1", "看一眼提交")] }));
    const done = await waitForStatus(other, readThread.id, "idle");
    expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-available");
  });

  /**
   * The self-built engine's deny path. It runs the AI SDK loop in this process,
   * so the denial travels the other way round from the harness engines': the
   * synthetic `execution-denied` result in the history *is* what the model sees,
   * which is why `stripDeniedApprovalResults` must stay off this engine.
   */
  it("leaves the file alone and finishes the turn when the write approval is denied", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const app = makeVgentApp(dataDir, mockModel([toolCallStream("call-w", "write", WRITE_INPUT), textStream("好的，我不写这个文件")]));
    const thread = await setupVgentThread(app, repoPath);
    const written = join(repoPath, "SMOKE.txt");

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "在根目录新建 SMOKE.txt")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");

    const denied = respond(parked.messages.at(-1)!, false);
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), denied] }));
    const done = await waitForStatus(app, thread.id, "idle");

    expect(await exists(written)).toBe(false);
    expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-denied");
    expect(JSON.stringify(done.messages)).toContain("好的，我不写这个文件");
  });

  it("ends the turn `awaiting-input` when the model calls askUserQuestions", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const questions = {
      allowPartialAnswers: false,
      questions: [{ id: "q1", question: "要覆盖已有文件吗？", options: [{ id: "yes", label: "覆盖" }] }],
    };
    const app = makeVgentApp(dataDir, mockModel([toolCallStream("call-q", "askUserQuestions", questions)]));
    const thread = await setupVgentThread(app, repoPath);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "问我一个问题")] }));
    const waiting = await waitForStatus(app, thread.id, "awaiting-input");

    // `askUserQuestions` has no `execute`, so the loop ends with the call open.
    const part = waiting.messages.at(-1)?.parts.find(isToolUIPart);
    expect(part?.state).toBe("input-available");
    expect(part?.type).toBe("tool-askUserQuestions");
  });

  it("keeps a pending approval across a restart and still executes the continuation", async () => {
    const dataDir = await tempDir();
    const repoPath = await tempDir();
    const written = join(repoPath, "SMOKE.txt");

    const appA = makeVgentApp(dataDir, mockModel([toolCallStream("call-w", "write", WRITE_INPUT)]));
    const thread = await setupVgentThread(appA, repoPath);
    await readSse(await postJson(appA, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "在根目录新建 SMOKE.txt")] }));
    const parked = await waitForStatus(appA, thread.id, "awaiting-approval");
    await waitForSlotReleased(appA, thread.id);
    await appA.shutdown();

    // A brand new app over the same data dir is what a restart looks like. The
    // engine is stateless, so neither `stopAll` nor the recovery pass may touch
    // the waiting thread.
    const appB = makeVgentApp(dataDir, mockModel([textStream("重启后也写好了")]));
    const restored = await getThread(appB, thread.id);
    expect(restored.status).toBe("awaiting-approval");
    expect(restored.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("approval-requested");

    const approved = approve(parked.messages.at(-1)!);
    await readSse(await postJson(appB, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), approved] }));
    const done = await waitForStatus(appB, thread.id, "idle");

    expect(await readFile(written, "utf8")).toBe(WRITE_INPUT.content);
    expect(done.messages.at(-1)?.parts.find(isToolUIPart)?.state).toBe("output-available");
    expect(JSON.stringify(done.messages)).toContain("重启后也写好了");
  });
});

describe("auto title", () => {
  /** A thread created without a title carries the placeholder. */
  async function untitledThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
    const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
    return (await (
      await postJson(app, "/api/threads", { projectId: project.id, engine: "claude-code" })
    ).json()) as ThreadRecord;
  }

  it("names an untitled thread after the first line of its first user message", async () => {
    const dataDir = await tempDir();
    const app = makeApp(dataDir, createApprovalEngine().factory);
    const thread = await untitledThread(app, dataDir);
    expect(thread.title).toBe(DEFAULT_THREAD_TITLE);

    await postJson(app, `/api/chat/${thread.id}`, {
      messages: [userMessage("u1", "  给 Web 端定三栏布局  \n第二行不应该进标题")],
    }).then((response) => response.text());

    const updated = await waitForStatus(app, thread.id, "idle");
    expect(updated.title).toBe("给 Web 端定三栏布局");
  });

  it("caps the derived title and leaves an explicit one alone", async () => {
    const dataDir = await tempDir();
    const app = makeApp(dataDir, createApprovalEngine().factory);

    const long = "长".repeat(AUTO_TITLE_MAX_LEN + 20);
    const untitled = await untitledThread(app, dataDir);
    await postJson(app, `/api/chat/${untitled.id}`, { messages: [userMessage("u1", long)] }).then((r) => r.text());
    expect((await waitForStatus(app, untitled.id, "idle")).title).toBe("长".repeat(AUTO_TITLE_MAX_LEN));

    const named = await setupThread(app, dataDir);
    await postJson(app, `/api/chat/${named.id}`, { messages: [userMessage("u2", "别改我的标题")] }).then((r) => r.text());
    expect((await waitForStatus(app, named.id, "idle")).title).toBe("审批");
  });

  it("derives nothing from a message with no usable text", () => {
    expect(deriveThreadTitle([])).toBeUndefined();
    expect(deriveThreadTitle([{ id: "a", role: "assistant", parts: [{ type: "text", text: "嗨" }] }])).toBeUndefined();
    expect(deriveThreadTitle([userMessage("u1", "   \n  ")])).toBeUndefined();
    expect(deriveThreadTitle([userMessage("u1", "\n\n真正的标题")])).toBe("真正的标题");
  });
});

describe("未读", () => {
  const patch = (app: VgentApp, threadId: string, body: unknown) =>
    request(app, `/api/threads/${threadId}`, { method: "PATCH", body: JSON.stringify(body) });

  it("回合自己停下就是未读：跑完、等审批都算，读过之后清掉", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createApprovalEngine().factory);
    const thread = await setupThread(app, dir);
    expect(thread.unread).toBeUndefined();

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "随便说点什么")] }));
    expect((await waitForStatus(app, thread.id, "idle")).unread).toBe(true);

    // 看过了：客户端在任务真的摆在眼前时发的那一下。
    const read = (await (await patch(app, thread.id, { unread: false })).json()) as ThreadRecord;
    expect(read.unread).toBeUndefined();
    expect((await getThread(app, thread.id)).unread).toBeUndefined();

    // 停在等审批同样是「它不动了，等你」。
    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u2", "用工具跑一下 uname")] }));
    expect((await waitForStatus(app, thread.id, "awaiting-approval")).unread).toBe(true);

    // 右键菜单的「标为未读 / 标为已读」走同一个字段。
    expect(((await (await patch(app, thread.id, { unread: false })).json()) as ThreadRecord).unread).toBeUndefined();
    expect(((await (await patch(app, thread.id, { unread: true })).json()) as ThreadRecord).unread).toBe(true);
  });

  it("出错也是未读", async () => {
    const dir = await tempDir();
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return { stream: toStream([{ type: "start" }, { type: "error", error: new Error("boom") }]) };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory);
    const thread = await setupThread(app, dir);

    await readSse(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "写个文件")] }));
    expect((await waitForStatus(app, thread.id, "error")).unread).toBe(true);
  });

  it("你按的停止不算未读，而未读这一个字段运行中也能改", async () => {
    const dir = await tempDir();
    let release = () => {};
    const factory: EngineFactoryOverride = {
      async create() {
        return {
          hasUnfinishedTurn: () => false,
          async finish() {},
          async destroy() {},
          async stream() {
            return {
              stream: new ReadableStream<TextStreamPart<ToolSet>>({
                start(controller) {
                  controller.enqueue({ type: "start" });
                  // Deliberately never closed until the test lets it go.
                  release = () => controller.close();
                },
              }),
            };
          },
        } satisfies EngineRunner;
      },
    };
    const app = makeApp(dir, factory, 100);
    const thread = await setupThread(app, dir);

    const post = postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "跑个久的")] });
    for (let attempt = 0; attempt < 100 && (await request(app, `/api/chat/${thread.id}/stream`)).status !== 200; attempt++) {
      await sleep(10);
    }

    // 运行中：改标题 409，标未读 200 —— 读一眼不是改任务。
    expect((await patch(app, thread.id, { title: "改名" })).status).toBe(409);
    const marked = await patch(app, thread.id, { unread: true });
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as ThreadRecord).unread).toBe(true);
    await patch(app, thread.id, { unread: false });

    expect((await postJson(app, `/api/chat/${thread.id}/stop`, {})).status).toBe(204);
    const stopped = await getThread(app, thread.id);
    expect(stopped.status).toBe("interrupted");
    expect(stopped.unread).toBeUndefined();

    release();
    await readSse(await post);
  });

  it("unread 只收布尔值", async () => {
    const dir = await tempDir();
    const app = makeApp(dir, createApprovalEngine().factory);
    const thread = await setupThread(app, dir);
    const bad = await patch(app, thread.id, { unread: "yes" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_unread" } });
  });
});
