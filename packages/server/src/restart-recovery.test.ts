import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage, TextStreamPart, ToolSet, UIMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { createEngineRegistry, type EngineContext, type EngineFactoryOverride } from "./engines/registry.js";
import { createQueueStore } from "./queue.js";
import { RESTART_RESUME_TEXT } from "./restart.js";
import { createRunManager, recoverInterruptedThreads, RESTART_INTERRUPT_TEXT, STOP_INTERRUPT_TEXT, RESTART_PENDING_TOOL_TEXT, type RunManager } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore, type ThreadPatch } from "./store/threads.js";
import type { HarnessState, ThreadRecord } from "./types.js";

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
// Fake engines and their models must not depend on the machine's real logins.
const appTestOptions = {
  probeClaudeLogin: async () => ({ loggedIn: false }),
  accountOptions: { probeCodex: async () => ({ codex: { available: false, source: null } }) },
  catalogFetch: async () => { throw new Error("offline test"); },
};
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});
const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const history = (): UIMessage[] => [user("original-user", "修复导出并交付"), {
  id: "original-assistant", role: "assistant", parts: [{ type: "text", text: "已完成修复，尚未核实发布结果" }],
}];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fakeEngine(options: { stateless?: boolean; gate?: ReturnType<typeof deferred>; ensureAvailable?: EngineFactoryOverride["ensureAvailable"] } = {}) {
  const created: EngineContext[] = [];
  const inputs: ModelMessage[][] = [];
  const factory: EngineFactoryOverride = {
    statelessTurns: options.stateless,
    ensureAvailable: options.ensureAvailable,
    async create(ctx) {
      created.push(ctx);
      return {
        hasUnfinishedTurn: () => false,
        async finish() {},
        async destroy() {},
        async stream({ messages, abortSignal }) {
          inputs.push(messages);
          const first = inputs.length === 1;
          return { stream: ReadableStream.from((async function* (): AsyncGenerator<TextStreamPart<ToolSet>> {
            yield { type: "start" };
            if (first && options.gate) {
              const release = () => options.gate!.resolve();
              abortSignal.addEventListener("abort", release, { once: true });
              try {
                if (abortSignal.aborted) release();
                await options.gate.promise;
              } finally {
                abortSignal.removeEventListener("abort", release);
              }
            }
            if (abortSignal.aborted) return;
            yield { type: "text-start", id: "reply" };
            yield { type: "text-delta", id: "reply", text: "恢复已完成" };
            yield { type: "text-end", id: "reply" };
          })()) };
        },
      };
    },
  };
  if (options.gate) cleanups.push(async () => { options.gate!.resolve(); });
  return { factory, created, inputs };
}
async function fixture(engine = fakeEngine()) {
  const dir = await mkdtemp(join(tmpdir(), "vgent-restart-recovery-"));
  dirs.push(dir);
  const threads = createThreadStore(dir);
  const projects = createProjectStore(dir);
  const project = await projects.create({ repoPath: dir });
  const registry = createEngineRegistry({ "claude-code": engine.factory });
  const seed = async (patch: ThreadPatch = {}) => {
    const thread = await threads.create({ projectId: project.id, engine: "claude-code", title: "恢复测试" });
    return threads.update(thread.id, { status: "running", messages: history(), ...patch });
  };
  const manager = (store = threads) => {
    const runs = createRunManager({ threads: store, projects, settings: createSettingsStore(dir), registry,
      dataDir: dir, queue: createQueueStore(store), stopTimeoutMs: 50 });
    cleanups.push(() => runs.stopAll());
    return runs;
  };
  return { dir, threads, registry, seed, manager, engine };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>, runs: RunManager, id: string) {
  await expect.poll(async () => {
    const stream = runs.subscribe(id);
    await stream?.cancel();
    return stream == null && (await f.threads.get(id))?.status === "idle";
  }).toBe(true);
  return (await f.threads.get(id))!;
}

describe("restart recovery", () => {
  it.each(["crash", "normal", "manual-stop"] as const)("%s shutdown only resumes an unexpectedly interrupted live turn", async mode => {
    const f = await fixture(fakeEngine({ gate: deferred() }));
    const thread = await f.seed({ status: "idle", messages: [] });
    const runs = f.manager();
    await runs.start(thread.id, [user("live-user", "完成原任务")]);
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    if (mode === "manual-stop") await runs.stop(thread.id);
    if (mode === "normal") await runs.stopAll();
    else await runs.stopAll({ recoverRunning: true });
    const interrupted = (await f.threads.get(thread.id))!;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.restartRecovery).toEqual(mode === "crash" ? expect.any(String) : undefined);
    expect(interrupted.messages[0]?.metadata).toMatchObject({
      turnEnd: { status: "interrupted", reason: mode === "crash" ? RESTART_INTERRUPT_TEXT : STOP_INTERRUPT_TEXT },
      run: { stopReason: mode === "crash" ? "unknown" : "cancelled" },
    });
    const rebuilt = createThreadStore(f.dir);
    await recoverInterruptedThreads(rebuilt, f.registry);
    const next = f.manager(rebuilt);
    await next.resumeInterrupted(thread.id);
    if (mode === "crash") await settled(f, next, thread.id);
    expect(f.engine.inputs).toHaveLength(mode === "crash" ? 2 : 1);
    if (mode === "crash") expect(JSON.stringify(f.engine.inputs[1])).toContain(RESTART_RESUME_TEXT);
  });

  it("app shutdown after losing the desktop parent preserves recovery for the next launch", async () => {
    const f = await fixture(fakeEngine({ gate: deferred() }));
    const thread = await f.seed();
    const first = createApp({ dataDir: f.dir, token: "restart-test-token", registry: f.registry, ...appTestOptions });
    cleanups.push(() => first.shutdown());
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    await first.shutdown({ recoverRunning: true });
    expect(await createThreadStore(f.dir).get(thread.id)).toMatchObject({ status: "interrupted", restartRecovery: expect.any(String) });
    const next = createApp({ dataDir: f.dir, token: "restart-test-token", registry: f.registry, ...appTestOptions });
    cleanups.push(() => next.shutdown());
    await expect.poll(async () => (await f.threads.get(thread.id))?.status).toBe("idle");
    expect(f.engine.inputs).toHaveLength(2);
  });

  it("durably saves the recovery token before sending abort", async () => {
    const gate = deferred();
    const f = await fixture(fakeEngine({ gate }));
    const thread = await f.seed({ status: "idle", messages: [] });
    const runs = f.manager();
    await runs.start(thread.id, [user("live-user", "完成原任务")]);
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    const saved = deferred();
    const release = deferred();
    let aborted = false;
    void gate.promise.then(() => { aborted = true; });
    const update = f.threads.update.bind(f.threads);
    const spy = vi.spyOn(f.threads, "update").mockImplementation(async (id, patch) => {
      const result = await update(id, patch);
      if (patch.restartRecovery != null) {
        saved.resolve();
        await release.promise;
      }
      return result;
    });
    const shutdown = runs.stopAll({ recoverRunning: true });
    try {
      await saved.promise;
      expect(aborted).toBe(false);
      expect(await createThreadStore(f.dir).get(thread.id)).toMatchObject({
        status: "interrupted", restartRecovery: expect.any(String),
      });
    } finally {
      release.resolve();
      await shutdown;
      spy.mockRestore();
    }
    expect(aborted).toBe(true);
  });

  it("reports recovery persistence failure without aborting", async () => {
    const f = await fixture(fakeEngine({ gate: deferred() }));
    const thread = await f.seed({ status: "idle", messages: [] });
    const runs = f.manager();
    await runs.start(thread.id, [user("live-user", "完成原任务")]);
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    const update = f.threads.update.bind(f.threads);
    const spy = vi.spyOn(f.threads, "update").mockImplementation(async (id, patch) => {
      if (patch.restartRecovery != null) throw new Error("disk unavailable");
      return update(id, patch);
    });
    try {
      await expect(runs.stopAll({ recoverRunning: true })).rejects.toThrow("disk unavailable");
      expect(runs.isRunning(thread.id)).toBe(true);
      expect((await createThreadStore(f.dir).get(thread.id))?.status).toBe("running");
    } finally {
      spy.mockRestore();
      await runs.stopAll();
    }
  });

  it.each([
    ["completed", { status: "idle" }],
    ["waiting", { status: "awaiting-input" }],
    ["archived", { archivedAt: "2026-01-01" }],
    ["transition", { transition: "archiving" }],
    ["outcome", { outcome: { kind: "discarded", at: "2026-01-01" } }],
    ["reclaimed", { workspace: { mode: "worktree", path: "/unused", branch: "unused", baseCommit: "unused", reclaimed: true } }],
    ["workspace creating", { workspaceState: "creating" }],
    ["pending approval", { messages: [user("u", "任务"), { id: "a", role: "assistant", parts: [
      { type: "tool-bash", toolCallId: "approval", state: "approval-requested", input: {}, approval: { id: "approve" } },
    ] }] }],
    ["pending question", { messages: [user("u", "任务"), { id: "a", role: "assistant", parts: [
      { type: "tool-askUserQuestions", toolCallId: "question", state: "input-available", input: { questions: [] } },
    ] }] }],
    ["no user message", { messages: [] }],
  ] satisfies [string, ThreadPatch][])("does not mark a live run whose persisted state is %s for recovery", async (_name, patch) => {
    const f = await fixture(fakeEngine({ gate: deferred() }));
    const thread = await f.seed({ status: "idle", messages: [] });
    const runs = f.manager();
    await runs.start(thread.id, [user("live-user", "完成原任务")]);
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    await f.threads.update(thread.id, patch);
    await runs.stopAll({ recoverRunning: true });
    expect((await f.threads.get(thread.id))?.restartRecovery).toBeUndefined();
  });

  it("createApp automatically resumes with the original goal, progress, model, mode and native session", async () => {
    const f = await fixture();
    const taskState: ThreadRecord["taskState"] = { goal: "修复导出并交付", items: [{ text: "核实发布", status: "in_progress" }] };
    const thread = await f.seed({ model: "test-model", mode: "plan", taskState });
    const state = { version: 1, sessionId: thread.id, updatedAt: new Date().toISOString(),
      resumeFrom: { harnessId: "fake", specificationVersion: 1, data: { session: "saved" } },
      continueFrom: { harnessId: "fake", specificationVersion: 1, data: { bridge: "dead" } },
    } as unknown as HarnessState;
    await f.threads.saveHarnessState(thread.id, state);
    const app = createApp({ dataDir: f.dir, token: "restart-test-token", registry: f.registry, ...appTestOptions });
    cleanups.push(() => app.shutdown());
    await expect.poll(async () => (await f.threads.get(thread.id))?.status).toBe("idle");
    expect(f.engine.inputs).toHaveLength(1);
    const ctx = f.engine.created[0]!;
    expect(ctx.thread).toMatchObject({ model: "test-model", mode: "plan", taskState });
    expect(ctx.planMode).toBe(true);
    expect(ctx.harnessState?.resumeFrom).toEqual(state.resumeFrom);
    expect(ctx.harnessState?.continueFrom).toBeUndefined();
    expect(ctx.continuesTurn).toBe(false);
    expect((await f.threads.loadHarnessState(thread.id))?.continueFrom).toBeUndefined();
    const last = f.engine.inputs[0]!.at(-1)!;
    expect(last.role).toBe("user");
    for (const text of [RESTART_RESUME_TEXT, "修复导出并交付", "已完成修复", "先核实文件、Git、进程及外部操作", "不能把结果缺失当作未执行或直接重放"]) {
      expect(JSON.stringify(last)).toContain(text);
    }
    const restored = (await f.threads.get(thread.id))!;
    expect(restored.restartRecovery).toBeUndefined();
    expect(restored.messages.slice(0, 2).map(message => message.id)).toEqual(history().map(message => message.id));
    expect(restored.messages.filter(message => message.role === "user")).toHaveLength(2);
    expect(restored.messages[2]?.parts).toEqual([{ type: "text", text: RESTART_RESUME_TEXT }]);
  });

  it("persists the intent across another store rebuild and claims concurrent resumes exactly once", async () => {
    const f = await fixture();
    const thread = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const marked = (await f.threads.get(thread.id))!;
    expect(marked.status).toBe("interrupted");
    expect(marked.restartRecovery).toEqual(expect.any(String));
    const rebuilt = createThreadStore(f.dir);
    await recoverInterruptedThreads(rebuilt, f.registry);
    expect((await rebuilt.get(thread.id))?.restartRecovery).toBe(marked.restartRecovery);
    expect((await rebuilt.get(thread.id))?.messages).toEqual(marked.messages);
    const runs = f.manager(rebuilt);
    await Promise.all(Array.from({ length: 5 }, () => runs.resumeInterrupted(thread.id)));
    const done = await settled(f, runs, thread.id);
    await runs.resumeInterrupted(thread.id);
    expect(f.engine.inputs).toHaveLength(1);
    expect(done.messages.filter(message => message.id === marked.restartRecovery)).toHaveLength(1);
  });

  it.each([
    ["manual interruption", { status: "interrupted" }],
    ["idle", { status: "idle" }],
    ["error", { status: "error" }],
    ["archived", { archivedAt: "2026-01-01" }],
    ["reclaimed", { workspace: { mode: "worktree", path: "/unused", branch: "unused", baseCommit: "unused", reclaimed: true } }],
    ["outcome", { outcome: { kind: "committed", at: "2026-01-01" } }],
    ["archiving", { transition: "archiving" }],
    ["budget", { status: "interrupted", messages: [user("u-budget", "继续原任务"), {
      id: "a-budget", role: "assistant", parts: [{ type: "text", text: "预算耗尽" }], metadata: { run: { stopReason: "budget" } },
    }] }],
  ] as [string, ThreadPatch][])("does not resume %s", async (_name, patch) => {
    const f = await fixture();
    const thread = await f.seed(patch);
    await recoverInterruptedThreads(f.threads, f.registry);
    await f.manager().resumeInterrupted(thread.id);
    expect((await f.threads.get(thread.id))?.restartRecovery).toBeUndefined();
    expect(f.engine.created).toEqual([]);
  });

  it.each(["running", "interrupted", "awaiting-approval", "awaiting-input"] as const)("preserves stateless human waits saved as %s", async status => {
    const f = await fixture(fakeEngine({ stateless: true }));
    for (const approval of [true, false]) {
      const part: UIMessage["parts"][number] = approval
        ? { type: "tool-bash", toolCallId: "approval", state: "approval-requested", input: {}, approval: { id: "approve" } }
        : { type: "tool-askUserQuestions", toolCallId: "question", state: "input-available", input: { questions: [] } };
      const waiting = approval ? "awaiting-approval" : "awaiting-input";
      if (status !== "running" && status !== "interrupted" && status !== waiting) continue;
      const thread = await f.seed({ status, ...(status === "interrupted" ? { restartRecovery: "before-abort" } : {}),
        messages: [user("u", "先问我"), { id: "a", role: "assistant", parts: [part] }] });
      await recoverInterruptedThreads(f.threads, f.registry);
      await f.manager().resumeInterrupted(thread.id);
      const restored = (await f.threads.get(thread.id))!;
      expect(restored.status).toBe(waiting);
      expect(restored.restartRecovery).toBeUndefined();
      expect(restored.messages.at(-1)?.parts).toEqual([part]);
    }
    expect(f.engine.created).toEqual([]);
  });

  it.each([
    ["running", true], ["running", false], ["awaiting-approval", true], ["awaiting-input", false],
  ] as const)("does not automatically execute stateful %s (approval: %s)", async (status, approval) => {
    const f = await fixture();
    const part: UIMessage["parts"][number] = approval
      ? { type: "tool-bash", toolCallId: "approval", state: "approval-requested", input: {}, approval: { id: "approve" } }
      : { type: "tool-askUserQuestions", toolCallId: "question", state: "input-available", input: { questions: [] } };
    const thread = await f.seed({ status, messages: [user("u", "先问我"), { id: "a", role: "assistant", parts: [part] }] });
    await recoverInterruptedThreads(f.threads, f.registry);
    await f.manager().resumeInterrupted(thread.id);
    expect((await f.threads.get(thread.id))?.restartRecovery).toBeUndefined();
    expect(f.engine.created).toEqual([]);
  });

  it.each([["running", "idle"], ["idle", "running"]] as const)("trusts the record over stale index %s / actual %s", async (indexed, actual) => {
    const f = await fixture();
    const thread = await f.seed({ status: indexed });
    const path = join(f.dir, "threads", `${thread.id}.json`);
    const record = JSON.parse(await readFile(path, "utf8")) as ThreadRecord;
    await writeFile(path, JSON.stringify({ ...record, status: actual }));
    const rebuilt = createThreadStore(f.dir);
    await recoverInterruptedThreads(rebuilt, f.registry);
    const runs = f.manager(rebuilt);
    await runs.resumeInterrupted(thread.id);
    if (actual === "running") await settled(f, runs, thread.id);
    expect(f.engine.inputs).toHaveLength(actual === "running" ? 1 : 0);
    expect((await rebuilt.list()).find(item => item.id === thread.id)?.status).toBe("idle");
  });

  it("keeps failed startup intent and history, reports the error, and recovers another thread", async () => {
    let blocked = "";
    const f = await fixture(fakeEngine({ ensureAvailable({ thread }) {
      if (thread.id === blocked) throw new Error("credentials unavailable");
    } }));
    const failed = await f.seed();
    blocked = failed.id;
    const good = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const before = (await f.threads.get(failed.id))!;
    const runs = f.manager();
    await runs.resumeInterrupted(failed.id);
    const after = (await f.threads.get(failed.id))!;
    expect(after.error).toContain("credentials unavailable");
    expect(after.unread).toBe(true);
    expect(after.restartRecovery).toBe(before.restartRecovery);
    expect(after.messages).toEqual(before.messages);
    await runs.resumeInterrupted(good.id);
    await settled(f, runs, good.id);
    expect(f.engine.created.map(ctx => ctx.thread.id)).toEqual([good.id]);
  });

  it.each(["manual", "stop"] as const)("%s before dispatch cancels automatic recovery", async action => {
    const f = await fixture();
    const thread = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const runs = f.manager();
    if (action === "manual") {
      await runs.start(thread.id, [user("manual", "改做这个")]);
      await settled(f, runs, thread.id);
    } else await runs.stop(thread.id);
    expect((await f.threads.get(thread.id))?.restartRecovery).toBeUndefined();
    await runs.resumeInterrupted(thread.id);
    expect(f.engine.inputs).toHaveLength(action === "manual" ? 1 : 0);
    expect(JSON.stringify((await f.threads.get(thread.id))?.messages)).not.toContain(RESTART_RESUME_TEXT);
  });

  it.each([
    ["stop", undefined],
    ["archive", { archivedAt: "2026-01-01" }],
    ["transition", { transition: "archiving" }],
    ["outcome", { outcome: { kind: "discarded", at: "2026-01-01" } }],
    ["reclaimed", { workspace: { mode: "worktree", path: "/unused", branch: "unused", baseCommit: "unused", reclaimed: true } }],
  ] satisfies [string, ThreadPatch | undefined][])("%s during the availability probe cancels recovery without an error", async (_action, patch) => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(fakeEngine({ async ensureAvailable() { entered.resolve(); await release.promise; } }));
    const thread = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const before = (await f.threads.get(thread.id))!;
    const runs = f.manager();
    const resume = runs.resumeInterrupted(thread.id);
    await entered.promise;
    try {
      // stop must return while the probe is still blocked, not after release.
      if (patch == null) await runs.stop(thread.id);
      else await f.threads.update(thread.id, patch);
      expect((await f.threads.get(thread.id))?.restartRecovery).toBeUndefined();
    } finally {
      release.resolve();
      await resume;
    }
    const after = (await f.threads.get(thread.id))!;
    expect(f.engine.created).toEqual([]);
    expect(after.messages).toEqual(before.messages);
    expect(after.error).toBe(before.error);
    expect(after.restartRecovery).toBeUndefined();
  });

  it("repairs a claimed record after an index write failure and retries with the same message id", async () => {
    const f = await fixture();
    const thread = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const before = (await f.threads.get(thread.id))!;
    const update = f.threads.update.bind(f.threads);
    let failed = false;
    const spy = vi.spyOn(f.threads, "update").mockImplementation(async (id, patch) => {
      const updated = await update(id, patch);
      if (!failed && patch.consumeRestartRecovery != null) {
        failed = true;
        throw new Error("index write failed");
      }
      return updated;
    });
    const runs = f.manager();
    try {
      await runs.resumeInterrupted(thread.id);
      const interrupted = (await f.threads.get(thread.id))!;
      expect(failed).toBe(true);
      expect(f.engine.created).toEqual([]);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.restartRecovery).toBe(before.restartRecovery);
      expect(interrupted.error).toContain("index write failed");
      expect(interrupted.messages.slice(0, before.messages.length)).toEqual(before.messages);
      expect(interrupted.messages.filter(message => message.id === before.restartRecovery)).toHaveLength(1);
      await runs.resumeInterrupted(thread.id);
      const done = await settled(f, runs, thread.id);
      expect(f.engine.inputs).toHaveLength(1);
      expect(done.messages.filter(message => message.id === before.restartRecovery)).toHaveLength(1);
      expect(done.restartRecovery).toBeUndefined();
      expect(done.error).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("shutdown during the availability probe prevents dispatch and any later starts", async () => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(fakeEngine({ async ensureAvailable() { entered.resolve(); await release.promise; } }));
    const thread = await f.seed();
    await recoverInterruptedThreads(f.threads, f.registry);
    const runs = f.manager();
    const resume = runs.resumeInterrupted(thread.id);
    await entered.promise;
    const shutdown = runs.stopAll();
    release.resolve();
    await Promise.all([resume, shutdown]);
    await runs.resumeInterrupted(thread.id);
    await expect(runs.start(thread.id, [user("late", "不能启动")])).rejects.toMatchObject({ code: "server_stopping" });
    expect(f.engine.created).toEqual([]);
    expect((await f.threads.get(thread.id))?.restartRecovery).toEqual(expect.any(String));
  });

  it("waits for recovery to finish normally before sending queued input", async () => {
    const gate = deferred();
    const f = await fixture(fakeEngine({ gate }));
    const thread = await f.seed({ queue: [{ id: "queued", text: "恢复后再做这个", createdAt: new Date().toISOString() }] });
    await recoverInterruptedThreads(f.threads, f.registry);
    const runs = f.manager();
    await runs.dispatchQueue(thread.id);
    expect(f.engine.inputs).toHaveLength(0);
    await runs.resumeInterrupted(thread.id);
    await expect.poll(() => f.engine.inputs.length).toBe(1);
    await runs.dispatchQueue(thread.id);
    expect(f.engine.inputs).toHaveLength(1);
    expect((await f.threads.get(thread.id))?.queue?.map(item => item.id)).toEqual(["queued"]);
    gate.resolve();
    await expect.poll(() => f.engine.inputs.length).toBe(2);
    const done = await settled(f, runs, thread.id);
    expect(JSON.stringify(f.engine.inputs[1]!.at(-1))).toContain("恢复后再做这个");
    expect(done.messages.filter(message => message.role === "user").map(message => message.id)).toEqual([
      "original-user", done.messages[2]!.id, "queued",
    ]);
    expect(done.queue ?? []).toEqual([]);
  });

  it.each([
    ["running", true], ["running", false], ["interrupted", true], ["interrupted", false],
  ] as const)("repairs unfinished tools from %s (stateless: %s), including a second crash before abort", async (status, stateless) => {
    const f = await fixture(fakeEngine({ stateless }));
    const thread = await f.seed({ status, ...(status === "interrupted" ? { restartRecovery: "before-abort" } : {}),
      messages: [{ ...user("u", "执行任务"), metadata: { run: { stopReason: "running" } } }, { id: "a", role: "assistant", parts: [
      { type: "tool-bash", toolCallId: "unfinished", state: "input-available", input: { command: "publish" } },
      { type: "tool-bash", toolCallId: "partial", state: "output-available", input: { command: "build" },
        output: { stdout: "partial log" }, preliminary: true },
    ] }] });
    await recoverInterruptedThreads(f.threads, f.registry);
    const recovered = (await f.threads.get(thread.id))!;
    expect(recovered.messages[0]?.metadata).toMatchObject({
      turnEnd: { status: "interrupted", reason: RESTART_INTERRUPT_TEXT },
      run: { stopReason: "unknown", endedAt: expect.any(String) },
    });
    if (status === "interrupted") expect(recovered.restartRecovery).toBe("before-abort");
    await recoverInterruptedThreads(createThreadStore(f.dir), f.registry);
    expect((await f.threads.get(thread.id))?.messages).toEqual(recovered.messages);
    expect((await f.threads.get(thread.id))?.restartRecovery).toBe(recovered.restartRecovery);
    expect(recovered.messages[1]?.parts[0]).toMatchObject({ state: "output-error", errorText: RESTART_PENDING_TOOL_TEXT });
    expect(recovered.messages[1]?.parts[1]).toMatchObject({ state: "output-available", preliminary: true, output: { stdout: "partial log" } });
    const runs = f.manager();
    await runs.resumeInterrupted(thread.id);
    const done = await settled(f, runs, thread.id);
    expect(done.messages[1]?.parts).toEqual(recovered.messages[1]?.parts);
    const results = f.engine.inputs[0]!.flatMap(message => message.role === "tool" ? message.content : []);
    for (const id of ["unfinished", "partial"]) {
      expect(results.find(part => part.type === "tool-result" && part.toolCallId === id)).toMatchObject({ output: { type: "error-text" } });
    }
    expect(JSON.stringify(results)).not.toContain("partial log");
  });
});
