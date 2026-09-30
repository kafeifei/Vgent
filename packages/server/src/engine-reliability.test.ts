import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createRunManager, recoverInterruptedThreads } from "./runs.js";
import { createVgentEngineFactory } from "./engines/vgent.js";
import { createEngineRegistry } from "./engines/registry.js";
import { createThreadStore } from "./store/threads.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createQueueStore } from "./queue.js";
import type { ThreadMessageMetadata } from "./types.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, reasoning: 0 },
  totalTokens: 2,
};
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-harness-contract-"));
  dirs.push(dir);
  return dir;
};
it("production factory and run manager persist a budget stop, not a clean response", async () => {
  const dataDir = await temp();
  const repoPath = await temp();
  await writeFile(join(repoPath, "a.txt"), "data");
  const threads = createThreadStore(dataDir),
    projects = createProjectStore(dataDir),
    settings = createSettingsStore(dataDir);
  const project = await projects.create({ repoPath });
  const thread = await threads.create({ projectId: project.id, engine: "vgent" });
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const id = `call-${++calls}`;
      return {
        stream: new ReadableStream({
          start(controller) {
            const chunks = [
              { type: "stream-start", warnings: [] },
              { type: "tool-input-start", id, toolName: "glob" },
              { type: "tool-input-delta", id, delta: '{"pattern":"*"}' },
              { type: "tool-input-end", id },
              { type: "tool-call", toolCallId: id, toolName: "glob", input: '{"pattern":"*"}' },
              { type: "finish", finishReason: { unified: "tool-calls" }, usage },
            ];
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  });
  const registry = createEngineRegistry({ vgent: createVgentEngineFactory({ model }) });
  const runs = createRunManager({ threads, projects, settings, dataDir, registry });
  try {
    const hub = await runs.start(thread.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "Inspect then summarize" }] }]);
    for await (const _ of hub.subscribe()) {
      /* drain */
    }
    let record = await threads.get(thread.id);
    for (let i = 0; i < 200 && record?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      record = await threads.get(thread.id);
    }
    expect(calls).toBe(100);
    expect(record!.status).toBe("interrupted");
    expect((record!.messages[0]!.metadata as ThreadMessageMetadata).run).toMatchObject({
      engine: "vgent",
      stopReason: "budget",
      steps: 100,
      providerAttempts: 100,
    });
    expect((record!.messages[0]!.metadata as ThreadMessageMetadata).turnEnd?.reason).toContain("预算");
  } finally {
    await runs.stopAll();
  }
});
it("a crash after claiming a queued request but before starting never drops it", async () => {
  const dataDir = await temp();
  const threads = createThreadStore(dataDir);
  const thread = await threads.create({ projectId: "p", engine: "vgent" });
  const queue = createQueueStore(threads);
  await queue.append(thread.id, "deliver original task");
  await queue.take(thread.id, { retain: true });
  const restored = createThreadStore(dataDir);
  await recoverInterruptedThreads(restored, createEngineRegistry());
  const record = await restored.get(thread.id);
  expect(record!.queue).toHaveLength(1);
  expect(record!.queue![0]!.accepted).toBe(false);
  expect(record!.queue![0]!.text).toBe("deliver original task");
});

it("manual compaction preserves recent original turns and their user constraints", async () => {
  const { compactThread, sinceCompaction } = await import("./compact.js");
  const dataDir = await temp();
  const store = createThreadStore(dataDir);
  const thread = await store.create({ projectId: "p", engine: "vgent" });
  const messages = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? ("assistant" as const) : ("user" as const),
    parts: [{ type: "text" as const, text: i === 6 ? "Do not restart; finish delivery" : `history ${i}` }],
  }));
  const model = new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: "text", text: "Earlier work and remaining delivery" }],
      finishReason: { unified: "stop" },
      usage,
      warnings: [],
    },
  });
  const marker = await compactThread({ thread: { ...thread, messages }, model });
  expect(marker.metadata).toMatchObject({ compacted: { before: 4, keptFrom: "m4" } });
  // The history stays; the model reads the summary, then the kept turns word for word.
  const read = sinceCompaction([...messages, marker]);
  expect(read[0]).toBe(marker);
  expect(read.slice(-4)).toEqual(messages.slice(-4));
  expect(JSON.stringify(read)).toContain("Do not restart");
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain("history 7");
});

it("the production factory describes a scratch session and refreshes approval facts on the next turn", async () => {
  const { NO_PROJECT_ID } = await import("./no-project.js");
  const { simulateReadableStream } = await import("ai");
  const dataDir = await temp();
  const threads = createThreadStore(dataDir), projects = createProjectStore(dataDir), settings = createSettingsStore(dataDir);
  const thread = await threads.create({ projectId: NO_PROJECT_ID, engine: "vgent" });
  const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "Ready." },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop" }, usage },
    ], chunkDelayInMs: null, initialDelayInMs: null,
  }) }) });
  const runs = createRunManager({ threads, projects, settings, dataDir, registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model }) }) });
  try {
    for (const [index, allowlist] of [[], ["write"]].entries()) {
      await settings.update({ runMode: "allow-reads", allowlist });
      const current = (await threads.get(thread.id))!;
      const hub = await runs.start(thread.id, [...current.messages, { id: `user-${index}`, role: "user", parts: [{ type: "text", text: "Describe your environment." }] }]);
      for await (const _ of hub.subscribe()) { /* drain the production stream */ }
      for (let i = 0; i < 200 && runs.isRunning(thread.id); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(model.doStreamCalls).toHaveLength(2);
    const first = JSON.stringify(model.doStreamCalls[0]!.prompt);
    const second = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(first).toContain("scratch workspace with no attached project");
    expect(first).not.toContain("This is the project's main working tree");
    expect(first).toContain("Calls to write, edit, bash, coder require tool approval");
    expect(second).toContain("Run without tool approval: read, write, grep, glob");
    expect(second).toContain("Applicable standing approvals");
  } finally { await runs.stopAll(); }
});

it("restores the complete request prefix across UI history turns and isolates thread cache sessions", async () => {
  const { simulateReadableStream } = await import("ai");
  const dataDir = await temp(), repoPath = await temp();
  const threads = createThreadStore(dataDir), projects = createProjectStore(dataDir), settings = createSettingsStore(dataDir);
  const project = await projects.create({ repoPath });
  const thread = await threads.create({ projectId: project.id, engine: "vgent" });
  const other = await threads.create({ projectId: project.id, engine: "vgent" });
  const plan = { items: [{ text: "CACHE_PLAN_SENTINEL", status: "in_progress" }] };
  let calls = 0;
  const model = new MockLanguageModelV3({
    provider: "codex-subscription.responses",
    doStream: async () => ({ stream: simulateReadableStream({
      chunks: ++calls === 1 ? [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "plan", toolName: "updatePlan" },
        { type: "tool-input-delta", id: "plan", delta: JSON.stringify(plan) },
        { type: "tool-input-end", id: "plan" },
        { type: "tool-call", toolCallId: "plan", toolName: "updatePlan", input: JSON.stringify(plan) },
        { type: "finish", finishReason: { unified: "tool-calls" }, usage },
      ] : [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Plan recorded." },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: { unified: "stop" }, usage },
      ], chunkDelayInMs: null, initialDelayInMs: null,
    }) }),
  });
  const runs = createRunManager({ threads, projects, settings, dataDir, registry: createEngineRegistry({ vgent: createVgentEngineFactory({ model }) }) });
  try {
    for (const [id, userId, text] of [
      [thread.id, "cache-user-one", "Make a plan."],
      [thread.id, "cache-user-two", "Continue with CACHE_NEW_PROVENANCE."],
      [other.id, "cache-other-user", "A separate task."],
    ] as const) {
      const current = (await threads.get(id))!;
      const messages = [...current.messages, { id: userId, role: "user" as const, parts: [{ type: "text" as const, text }] }];
      const hub = await runs.start(id, messages);
      for await (const _ of hub.subscribe()) { /* drain */ }
      // The hub closes before the final assistant history is persisted.
      let record = (await threads.get(id))!;
      for (let i = 0; i < 200 && record.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        record = (await threads.get(id))!;
      }
      expect(record.status).toBe("idle");
      expect(record.messages.at(-1)?.role).toBe("assistant");
    }
    expect(model.doStreamCalls).toHaveLength(4);
    for (const [index, call] of model.doStreamCalls.entries()) {
      const id = index === 3 ? other.id : thread.id;
      expect(call.providerOptions?.openai?.promptCacheKey).toBe(id);
      expect(call.headers?.["session-id"]).toBe(id);
    }
    const [initial, planned, resumed] = model.doStreamCalls.map((call) => call.prompt);
    expect(planned!.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("CACHE_PLAN_SENTINEL") });
    expect(resumed!.slice(0, planned!.length)).toEqual(planned);
    expect(resumed![0]).toEqual(initial![0]);
    expect(resumed![0]!.role).toBe("system");
    expect(JSON.stringify(resumed![0])).not.toContain("CACHE_NEW_PROVENANCE");
    expect(resumed!.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("cache-user-two: Continue with CACHE_NEW_PROVENANCE.") });
    expect((await threads.get(thread.id))!.taskState?.items).toEqual(plan.items);
  } finally { await runs.stopAll(); }
});
