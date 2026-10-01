import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createVgentEngine } from "./engine.js";
import { promptCaching } from "./prompt-caching.js";
import { isRuntimeContext } from "./runtime-context.js";
import { saveContext } from "./context-cache.js";
import type { TaskState } from "./update-plan.js";

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), "vgent-cache-")); dirs.push(dir); return dir; };
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 }, totalTokens: 25 };
const answer = { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const }, usage, warnings: [] };
const call = (toolName: string, input: object) => ({ content: [{ type: "tool-call" as const, toolCallId: "t1", toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const }, usage, warnings: [] });
const initial: ModelMessage[] = [{ role: "user", content: "Work carefully" }];
const plan: TaskState = { goal: "Deliver", items: [{ text: "verify", status: "pending" }] };

it("budgets hosted search schemas only after they enter history, not the entire deferred catalog", async () => {
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", modelId: "gpt-6-astra", doGenerate: answer });
  const description = "Synthetic deferred schema ".repeat(4000);
  const parameters = { type: "object" as const, properties: {}, additionalProperties: false };
  const engine = createVgentEngine({
    model, repoPath: await temp(), subagents: false, contextTokenBudget: 10000,
    extraTools: { srv__large: { description, inputSchema: jsonSchema(parameters), deferLoading: true, execute: async () => "done" } },
  });
  try {
    expect((await engine.agent.generate({ messages: initial })).text).toBe("done");
    expect(model.doGenerateCalls).toHaveLength(1);
    const discovered: ModelMessage[] = [
      ...initial,
      { role: "assistant", content: [
        { type: "tool-call", toolCallId: "search", toolName: "tool_search", input: { arguments: { query: "large" } }, providerExecuted: true },
        { type: "tool-result", toolCallId: "search", toolName: "tool_search", output: { type: "json", value: { tools: [{ type: "function", name: "srv__large", description, parameters }] } } },
      ] },
    ];
    await expect(engine.agent.generate({ messages: discovered })).rejects.toThrow(/容量/);
    expect(model.doGenerateCalls).toHaveLength(1);
  } finally { await engine.dispose(); }
});

it("uses SDK options only on supported models and reserves the session header for Codex", () => {
  for (const provider of ["google.generative-ai", "anthropic.messages", "amazon-bedrock", "custom.chat"]) {
    expect(promptCaching(new MockLanguageModelV3({ provider }), "task")).toEqual({});
  }
  expect(promptCaching(new MockLanguageModelV3({ provider: "openai.responses" }), "task")).toEqual({
    providerOptions: { openai: { promptCacheKey: "task" } }, allowSystemInMessages: true,
  });
  expect(promptCaching(new MockLanguageModelV3({ provider: "gateway", modelId: "openai/gpt-test" }), "task")).toEqual({
    providerOptions: { openai: { promptCacheKey: "task" } },
  });
  expect(promptCaching(new MockLanguageModelV3({ provider: "local.responses" }), "task", [{ id: "local", name: "Local", agents: { vgent: { protocol: "openai", baseURL: "https://example.test/v1", models: [] } } }])).toEqual({
    providerOptions: { openai: { promptCacheKey: "task" } }, allowSystemInMessages: true,
  });
});

it("uses a stable non-path cache key for a CLI session and isolates ephemeral engines", async () => {
  const repoPath = await temp();
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: answer });
  for (const sessionFile of [join(repoPath, "cli.jsonl"), join(repoPath, "cli.jsonl"), undefined, undefined]) {
    await createVgentEngine({ model, repoPath, ...(sessionFile ? { sessionFile } : {}), subagents: false }).agent.generate({ messages: initial });
  }
  const keys = model.doGenerateCalls.map((request) => request.providerOptions?.openai?.promptCacheKey);
  expect(keys[0]).toBe(keys[1]); expect(keys[0]).not.toContain(repoPath);
  expect(keys[2]).not.toBe(keys[3]);
  for (const request of model.doGenerateCalls) expect(request.headers?.["session-id"]).toBe(request.providerOptions?.openai?.promptCacheKey);
});

it("a plan change leaves the request alone: every step and the next turn only extend the one before", async () => {
  const repoPath = await temp(); const outputDir = join(repoPath, "out");
  let taskState = plan;
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: [call("updatePlan", { items: [{ text: "verify", status: "done" }] }), answer, answer] });
  const options = { model, repoPath, outputDir, sessionId: "task", subagents: false };
  const result = await createVgentEngine({ ...options, taskState, saveTaskState: async (state) => { taskState = state; } }).agent.generate({ messages: initial });
  const [first, second] = model.doGenerateCalls;
  expect(second!.prompt.slice(0, first!.prompt.length)).toEqual(first!.prompt);
  // Nothing but the instructions is a system message; the plan lives in its own tool call.
  expect(second!.prompt.filter((message) => message.role === "system")).toHaveLength(1);
  expect(JSON.stringify(second!.prompt)).not.toContain("Deliver");
  expect(taskState.items).toEqual([{ text: "verify", status: "done" }]);
  const history: ModelMessage[] = [...initial, ...result.responseMessages, { role: "user", content: "Continue" }];
  await createVgentEngine({ ...options, taskState }).agent.generate({ messages: history });
  expect(model.doGenerateCalls[2]!.prompt.slice(0, second!.prompt.length)).toEqual(second!.prompt);
});

const LEGACY_SNAPSHOT: ModelMessage = {
  role: "system",
  content: "Vgent runtime state snapshot (replaces earlier runtime state snapshots; not a new user request; verify evidence and follow the latest user corrections):\n{}",
};

it("reuses an older build's saved snapshots on Responses, and never replays them to a protocol that rejects them", async () => {
  expect(isRuntimeContext(LEGACY_SNAPSHOT)).toBe(true);
  const repoPath = await temp(); const outputDir = join(repoPath, "out");
  await saveContext(outputDir, initial, [...initial, LEGACY_SNAPSHOT]);
  const history: ModelMessage[] = [...initial, { role: "user", content: "Continue" }];
  const codex = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: answer });
  await createVgentEngine({ model: codex, repoPath, outputDir, subagents: false }).agent.generate({ messages: history });
  // The same prefix the provider saw last time.
  expect(codex.doGenerateCalls[0]!.prompt.filter((message) => message.role === "system")).toHaveLength(2);
  const other = new MockLanguageModelV3({ provider: "google.generative-ai", doGenerate: answer });
  await createVgentEngine({ model: other, repoPath, outputDir, subagents: false }).agent.generate({ messages: history });
  expect(other.doGenerateCalls[0]!.prompt.filter((message) => message.role === "system")).toHaveLength(1);
  expect(JSON.stringify(other.doGenerateCalls[0]!.prompt)).not.toContain("Vgent runtime state snapshot");
});

it("keeps budget closing instructions to the closing step", async () => {
  const repoPath = await temp(); const outputDir = join(repoPath, "out");
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: [call("glob", { pattern: "*" }), answer, answer] });
  const options = { model, repoPath, outputDir, maxSteps: 2, subagents: false };
  const result = await createVgentEngine(options).agent.generate({ messages: initial });
  expect(model.doGenerateCalls[1]!.prompt[0]!.content).toContain("Execution budget is nearly exhausted");
  await createVgentEngine(options).agent.generate({ messages: [...initial, ...result.responseMessages, { role: "user", content: "Continue" }] });
  expect(model.doGenerateCalls[2]!.prompt[0]!.content).not.toContain("Execution budget is nearly exhausted");
});

it("reads a 插话 once on the next turn, and saves no mapping when nothing was compacted", async () => {
  const repoPath = await temp(); const outputDir = join(repoPath, "out");
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: [call("glob", { pattern: "*" }), answer, answer] });
  const options = { model, repoPath, outputDir, subagents: false };
  const result = await createVgentEngine({ ...options, pendingUserMessages: async () => ["STEER: verify only"] }).agent.generate({ messages: initial });
  await expect(readFile(join(outputDir, "context-state.json"), "utf8")).rejects.toThrow();
  const history: ModelMessage[] = [...initial, ...result.responseMessages.slice(0, -1), { role: "user", content: "STEER: verify only" }, result.responseMessages.at(-1)!, { role: "user", content: "Continue" }];
  await createVgentEngine(options).agent.generate({ messages: history });
  expect(JSON.stringify(model.doGenerateCalls[2]!.prompt).match(/STEER: verify only/g)).toHaveLength(1);
});

it.each([false, true])("resumes approved tools exactly once even when the context cache is unwritable: %s", async (blocked) => {
  const repoPath = await temp(); const outputDir = join(repoPath, "out");
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: [call("write", { file_path: "approved.txt", content: "verified" }), answer, answer] });
  let writes = 0;
  const options = { model, repoPath, outputDir, sessionId: "approval-task", permissionMode: "allow-reads" as const, subagents: false,
    onEvent: (event: { type: string; toolName?: string }) => { if (event.type === "tool-end" && event.toolName === "write") writes++; },
  };
  const first = await createVgentEngine(options).agent.generate({ messages: initial });
  const approval = first.content.find((part) => part.type === "tool-approval-request")!;
  expect(approval).toBeDefined();
  expect(writes).toBe(0);
  if (blocked) {
    await rm(join(outputDir, "context-state.json"), { recursive: true, force: true });
    await mkdir(join(outputDir, "context-state.json"), { recursive: true });
  }
  const history: ModelMessage[] = [...initial, ...first.responseMessages, { role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true }] }];
  const resumed = await createVgentEngine(options).agent.generate({ messages: history });
  expect(resumed.text).toBe("done");
  expect(writes).toBe(1);
  expect(await readFile(join(repoPath, "approved.txt"), "utf8")).toBe("verified");
  await createVgentEngine(options).agent.generate({ messages: [...history, ...resumed.responseMessages, { role: "user", content: "Continue" }] });
  expect(writes).toBe(1);
  expect(model.doGenerateCalls).toHaveLength(3);
});

it("reuses a saved compaction on the next turn and keeps the latest constraint", async () => {
  const repoPath = await temp();
  const outputDir = join(repoPath, "out");
  const history: ModelMessage[] = [
    ...initial,
    LEGACY_SNAPSHOT,
    ...Array.from({ length: 10 }, (_, i): ModelMessage => ({ role: i % 2 ? "assistant" : "user", content: `old ${i} ${"x".repeat(3000)}` })),
    { role: "user", content: "LATEST CONSTRAINT: do not restart" },
    { role: "assistant", content: "checking" },
    { role: "user", content: "recent" },
    { role: "assistant", content: "checking" },
    { role: "user", content: "Continue" },
  ];
  await saveContext(outputDir, initial, history);
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", doGenerate: answer });
  await createVgentEngine({ model, repoPath, outputDir, taskState: plan, contextTokenBudget: 10000, subagents: false }).agent.generate({ messages: initial });
  const request = model.doGenerateCalls.at(-1)!;
  expect(JSON.stringify(request.prompt)).toContain("LATEST CONSTRAINT: do not restart");
  // The plan is not injected; the model reads it from its own tool calls.
  expect(JSON.stringify(request.prompt)).not.toContain('\\"goal\\":\\"Deliver\\"');
  expect(model.doGenerateCalls.length).toBeGreaterThan(1);
  const saved = JSON.parse(await readFile(join(outputDir, "context-state.json"), "utf8"));
  expect(saved.count).toBe(initial.length);
});

it("treats corrupt context state as a cache miss", async () => {
  const repoPath = await temp();
  await writeFile(join(repoPath, "context-state.json"), "{invalid");
  const { restoreContext } = await import("./context-cache.js");
  expect(await restoreContext(repoPath, initial)).toEqual(initial);
  expect(initial).toHaveLength(1);
});
