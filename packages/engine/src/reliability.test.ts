import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { APICallError, simulateReadableStream, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createVgentEngine } from "./engine.js";
import { createMemoryTool } from "./memory.js";
import { createTaskPlan } from "./update-plan.js";
import { fitContext } from "./context.js";
import { classifyFailure } from "./failures.js";
const dirs: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-reliability-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
  totalTokens: 25,
};
const answer = (text = "done") => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const },
  usage,
  warnings: [],
});
const call = (name: string, input: object) => ({
  content: [{ type: "tool-call" as const, toolCallId: "t1", toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const },
  usage,
  warnings: [],
});
const opts = { toolCallId: "t", messages: [] };
it("injects accessed subdirectory instructions into the next actual provider request", async () => {
  const repoPath = await temp();
  await mkdir(join(repoPath, "nested"));
  await writeFile(join(repoPath, "nested/AGENTS.md"), "NESTED_SENTINEL: keep the custom format.");
  await writeFile(join(repoPath, "nested/a.txt"), "hello");
  const model = new MockLanguageModelV3({ doGenerate: [call("read", { file_path: "nested/a.txt" }), answer()] });
  await createVgentEngine({ model, repoPath, subagents: false }).agent.generate({ prompt: "Inspect nested/a.txt" });
  expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).not.toContain("NESTED_SENTINEL");
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("NESTED_SENTINEL");
});
it("reserves the last step for a bounded handoff and reports budget, not completion", async () => {
  const model = new MockLanguageModelV3({ doGenerate: [call("glob", { pattern: "*" }), answer("Still pending: verification.")] });
  const engine = createVgentEngine({ model, repoPath: await temp(), maxSteps: 2, subagents: false });
  await engine.agent.generate({ prompt: "Do a large task" });
  expect(model.doGenerateCalls[1]!.tools ?? []).toEqual([]);
  expect(engine.outcome()).toMatchObject({ stopReason: "budget", steps: 2, providerAttempts: 2 });
});
it("retains omitted unfinished work and persists before acknowledging the new plan", async () => {
  const saved: unknown[] = [];
  const plan = createTaskPlan({ goal: "Ship change", items: [{ text: "install Debug", status: "pending" }] }, async (state) => {
    saved.push(state);
  });
  await plan.tool.execute!({ items: [{ text: "investigate rule loading", status: "in_progress" }] }, opts);
  expect(plan.get()!.items.map((item) => item.text)).toContain("install Debug");
  expect(saved).toHaveLength(1);
  await plan.tool.execute!({ replaceReason: "User cancelled delivery", items: [] }, opts);
  expect(plan.get()!.items).toEqual([]);
});
it("stores a verified user quotation without expanding a no-restart constraint", async () => {
  const memoryDir = await temp();
  const memory = createMemoryTool(memoryDir, [{ id: "u1", text: "写完发 debug，但别自动重启" }]);
  await memory.execute!(
    {
      action: "write",
      name: "delivery",
      kind: "user-instruction",
      content: "不能替换应用",
      source: { messageId: "u1", quote: "写完发 debug，但别自动重启" },
    },
    opts,
  );
  const stored = await readFile(join(memoryDir, "delivery.md"), "utf8");
  expect(stored).toContain('"messageId":"u1"');
  expect(stored).toContain("别自动重启");
  expect(stored).not.toContain("不能替换");
  const denied = await memory.execute!(
    { action: "write", name: "delivery", kind: "user-instruction", content: "no", source: { messageId: "u1", quote: "不要安装" } },
    opts,
  );
  expect(denied).toContain("必须引用");
  expect(await readFile(join(memoryDir, "delivery.md"), "utf8")).toBe(stored);
});
it("compacts long text while retaining recent original requests and archive references", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => answer("Goal: deliver Debug. Constraint: do not restart. Remaining: verify and install."),
  });
  const messages: ModelMessage[] = [
    { role: "user", content: "Deliver Debug, do not restart." },
    ...Array.from({ length: 8 }, (_, i): ModelMessage => ({
      role: i % 2 ? "assistant" : "user",
      content: `history ${i}: ${"x".repeat(5000)}`,
    })),
    { role: "user", content: "LATEST: preserve my changes" },
    { role: "assistant", content: "Checking" },
  ];
  // Keep the recent span short enough to fit without discarding its originals.
  for (let i = 5; i < messages.length - 2; i++) messages[i] = { role: i % 2 ? "user" : "assistant", content: `recent ${i}` };
  const result = await fitContext({ model, messages, budget: 5000, archive: async () => "/saved/transcript.json" });
  expect(result.compacted).toBe(true);
  expect(JSON.stringify(result.messages)).toContain("LATEST: preserve my changes");
  expect(JSON.stringify(result.messages)).toContain("/saved/transcript.json");
  expect(messages[0]!.content).toBe("Deliver Debug, do not restart.");
});
it("rejects oversized single inputs without calling the provider repeatedly", async () => {
  const model = new MockLanguageModelV3({ doGenerate: answer() });
  await expect(fitContext({ model, messages: [{ role: "user", content: "x".repeat(20000) }], budget: 1000 })).rejects.toThrow(/容量/);
  expect(model.doGenerateCalls).toHaveLength(0);
});
it("a 403 marked retryable by a gateway is still terminal and classified", async () => {
  const error = new APICallError({
    message: "Model is blocked",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode: 403,
    isRetryable: true,
  });
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });
  const engine = createVgentEngine({ model, repoPath: await temp(), subagents: false });
  await expect(engine.agent.generate({ prompt: "hello" })).rejects.toThrow("Model is blocked");
  expect(model.doGenerateCalls).toHaveLength(1);
  expect(engine.outcome().errorClass).toBe("authorization");
  expect(classifyFailure(new Error("wrapped", { cause: error }))).toBe("authorization");
});

it("reuses an exact compacted prefix across turns, but never after a history edit", async () => {
  const { restoreContext, saveContext } = await import("./context-cache.js");
  const dir = await temp();
  const original: ModelMessage[] = [{ role: "user", content: "original goal" }, { role: "assistant", content: "old details" }];
  const summary: ModelMessage[] = [{ role: "user", content: "summary: original goal remains" }];
  await saveContext(dir, original, summary);
  const next: ModelMessage = { role: "user", content: "Continue, preserve the new constraint" };
  expect(await restoreContext(dir, [...original, next])).toEqual([...summary, next]);
  const changed: ModelMessage[] = [{ role: "user", content: "different goal" }, original[1]!, next];
  expect(await restoreContext(dir, changed)).toEqual(changed);
});

it("usage calibration includes tool schemas and does not repeatedly compact an otherwise fitting request", async () => {
  const { estimateTokens } = await import("./context.js");
  const repoPath = await temp(); await writeFile(join(repoPath, "value.txt"), "verified");
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async (params) => {
    const inputTokens = estimateTokens(params.prompt) + estimateTokens(params.tools ?? []);
    const result = ++calls === 1 ? call("read", { file_path: "value.txt" }) : answer("verified");
    return { ...result, usage: { ...usage, inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 } } };
  } });
  const engine = createVgentEngine({ model, repoPath, subagents: false, contextTokenBudget: 7500 });
  const result = await engine.agent.generate({ prompt: `Read value.txt then answer. Reference context: ${"a".repeat(7000)}` });
  expect(result.text).toBe("verified"); expect(calls).toBe(2);
});
