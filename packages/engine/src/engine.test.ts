import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createVgentEngine,
  portableReasoning,
  reasoningProviderOptions,
  resolveModel,
  usesOpenAIReasoning,
  type VgentEngineEvent,
} from "./engine.js";
import { loadSession } from "./session-store.js";

const NO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, reasoning: undefined },
  totalTokens: undefined,
};

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "vgent-engine-"));
  await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
});

/**
 * A model that calls `read` on the first step and answers with text on the
 * second, which is the shortest path that exercises the whole loop: tool
 * resolution, approval, execution, and the final answer.
 */
function readThenAnswer(finalText: string) {
  return new MockLanguageModelV3({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "call-1",
            toolName: "read",
            input: JSON.stringify({ file_path: "hello-vgent.txt" }),
          },
        ],
        finishReason: { unified: "tool-calls" as const },
        usage: NO_USAGE,
        warnings: [],
      },
      {
        content: [{ type: "text" as const, text: finalText }],
        finishReason: { unified: "stop" as const },
        usage: NO_USAGE,
        warnings: [],
      },
    ],
  });
}

describe("createVgentEngine", () => {
  it("runs a tool call through the agent and returns the final text", async () => {
    const model = readThenAnswer("hello from vgent");
    const { agent, dispose } = createVgentEngine({ model, repoPath, permissionMode: "allow-reads" });

    const result = await agent.generate({ prompt: "Read hello-vgent.txt." });

    expect(result.text).toBe("hello from vgent");
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(["read"]);
    // The tool actually ran against the temp repo: its output carries the file's content.
    expect(result.toolResults).toHaveLength(1);
    expect(JSON.stringify(result.toolResults[0]!.output)).toContain("hello from vgent");
    expect(result.steps).toHaveLength(2);
    await dispose();
  });

  it("offers only the read-only tools in a 计划 turn", async () => {
    const { agent } = createVgentEngine({
      model: readThenAnswer("done"),
      repoPath,
      plan: true,
      memoryDir: join(repoPath, "memory"),
      extraTools: { deploy: { description: "写点什么", inputSchema: z.object({}), execute: async () => "ok" } },
    });
    // No `write` / `edit` / `bash` / `coder` / `memory`, and no MCP tool either.
    expect(Object.keys(agent.tools ?? {}).sort()).toEqual(["askUserQuestions", "explore", "glob", "grep", "read", "updatePlan"]);
  });

  it("exposes the built-in tools plus askUserQuestions, updatePlan and the subagents, and askUserQuestions has no execute", async () => {
    const { agent } = createVgentEngine({ model: readThenAnswer("done"), repoPath });
    expect(Object.keys(agent.tools ?? {}).sort()).toEqual([
      "askUserQuestions",
      "bash",
      "coder",
      "edit",
      "explore",
      "glob",
      "grep",
      "read",
      "updatePlan",
      "write",
    ]);
    // No `execute` is what makes the loop stop and hand the question to the UI.
    expect((agent.tools as Record<string, { execute?: unknown }>).askUserQuestions!.execute).toBeUndefined();
  });

  it("adds the memory tool only when a memory directory is given", async () => {
    const { agent } = createVgentEngine({ model: readThenAnswer("done"), repoPath, memoryDir: join(repoPath, "..", "memory") });
    expect(Object.keys(agent.tools ?? {})).toContain("memory");
  });

  it("puts the working directory and permission mode into the instructions it sends", async () => {
    const model = readThenAnswer("ok");
    const { agent } = createVgentEngine({
      model,
      repoPath,
      permissionMode: "allow-reads",
      instructions: "Extra project rule: speak like a pirate.",
    });
    await agent.generate({ prompt: "Read hello-vgent.txt." });

    const instructions = (model.doGenerateCalls[0] as LanguageModelV3CallOptions).prompt.find(
      (message) => message.role === "system",
    );
    const text = JSON.stringify(instructions);
    expect(text).toContain(repoPath);
    expect(text).toContain("allow-reads");
    expect(text).toContain("speak like a pirate");
  });

  it("requires approval for bash in allow-reads instead of executing it", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "bash",
              input: JSON.stringify({ command: "git status" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const },
          usage: NO_USAGE,
          warnings: [],
        },
      ],
    });
    const { agent } = createVgentEngine({ model, repoPath, permissionMode: "allow-reads" });

    const result = await agent.generate({ prompt: "Check git status." });

    expect(result.content.some((part) => part.type === "tool-approval-request")).toBe(true);
    expect(result.toolResults).toHaveLength(0);
  });

  it("插话：两步之间把用户新说的话放到模型面前，只放一次，第一步之前不放", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [{ type: "tool-call" as const, toolCallId: "call-1", toolName: "glob", input: JSON.stringify({ pattern: "*.nothing" }) }],
          finishReason: { unified: "tool-calls" as const },
          usage: NO_USAGE,
          warnings: [],
        },
        {
          content: [{ type: "tool-call" as const, toolCallId: "call-2", toolName: "glob", input: JSON.stringify({ pattern: "*.nothing" }) }],
          finishReason: { unified: "tool-calls" as const },
          usage: NO_USAGE,
          warnings: [],
        },
        { content: [{ type: "text" as const, text: "好" }], finishReason: { unified: "stop" as const }, usage: NO_USAGE, warnings: [] },
      ],
    });
    let asked = 0;
    const { agent } = createVgentEngine({
      model,
      repoPath,
      permissionMode: "allow-all",
      // Asked before steps 1 and 2; only the first time is there anything to say.
      pendingUserMessages: async () => (asked++ === 0 ? ["顺便改 b.ts"] : []),
    });

    await agent.generate({ prompt: "重构 a.ts" });

    const userTexts = (call: number): string[] =>
      (model.doGenerateCalls[call]?.prompt ?? []).flatMap((message) =>
        message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
      );
    expect(asked).toBe(2);
    expect(userTexts(0)).toEqual(["重构 a.ts"]);
    expect(userTexts(1)).toEqual(["重构 a.ts", "顺便改 b.ts"]);
    // The injected message is part of the base now: still there, still once.
    expect(userTexts(2)).toEqual(["重构 a.ts", "顺便改 b.ts"]);
    expect(model.doGenerateCalls[1]?.prompt.at(-1)?.role).toBe("user");
  });

  /**
   * What 自动改文件 (the default run mode) does and does not hand over: writes
   * inside the working directory run unattended, a write that points outside it
   * fails in the tool rather than asking, and shell commands still stop for the
   * human unless the allowlist names them.
   */
  it("in allow-edits, writes cannot leave the working directory and bash still asks", async () => {
    const escape = join(repoPath, "..", `vgent-escape-${Date.now()}.txt`);
    const model = new MockLanguageModelV3({
      doGenerate: [
        {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "write",
              input: JSON.stringify({ file_path: escape, content: "escaped" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const },
          usage: NO_USAGE,
          warnings: [],
        },
        {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-2",
              toolName: "bash",
              input: JSON.stringify({ command: "rm -rf /" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const },
          usage: NO_USAGE,
          warnings: [],
        },
      ],
    });
    const { agent } = createVgentEngine({ model, repoPath, permissionMode: "allow-edits" });

    const result = await agent.generate({ prompt: "Write outside, then clean up." });

    const failed = result.steps[0]?.content.find((part) => part.type === "tool-error");
    expect(String((failed as { error?: unknown } | undefined)?.error)).toMatch(/outside the working directory/);
    await expect(readFile(escape, "utf8")).rejects.toThrow();
    // The shell command is a different question, and 自动改文件 does not answer it.
    expect(result.content.some((part) => part.type === "tool-approval-request")).toBe(true);
    expect(result.toolResults).toHaveLength(0);
  });

  it("appends the turn to the session file and loads it back", async () => {
    const sessionFile = join(repoPath, ".vgent", "session.jsonl");
    const { agent } = createVgentEngine({
      model: readThenAnswer("hello from vgent"),
      repoPath,
      permissionMode: "allow-reads",
      sessionFile,
    });

    await agent.generate({ prompt: "Read hello-vgent.txt." });

    const messages = await loadSession(sessionFile);
    expect(messages[0]).toEqual({ role: "user", content: "Read hello-vgent.txt." });
    expect(messages.at(-1)).toMatchObject({ role: "assistant" });
    // The user message, the assistant tool call, the tool result, the answer.
    expect(messages).toHaveLength(4);
    expect(await readFile(sessionFile, "utf8")).toMatch(/\n$/);
  });

  it("reports lifecycle summaries without token values", async () => {
    const events: VgentEngineEvent[] = [];
    const { agent } = createVgentEngine({
      model: readThenAnswer("hello from vgent"),
      repoPath,
      permissionMode: "allow-reads",
      onEvent: (event) => events.push(event),
    });

    await agent.generate({ prompt: "Read hello-vgent.txt." });

    expect(events.filter((event) => event.type === "step-end")).toHaveLength(2);
    const toolEvent = events.find((event) => event.type === "tool-end");
    expect(toolEvent).toMatchObject({ toolName: "read", ok: true });
    expect(JSON.stringify(events)).not.toMatch(/token/i);
  });
});

/**
 * A mock that answers in one step and records the call options it was handed.
 * `provider`/`modelId` are the real ones a Codex subscription model reports —
 * verified against `createOpenAI({ name: 'codex-subscription' }).responses(id)`
 * — so `usesOpenAIReasoning` recognises it exactly as it does in production.
 */
function answeringMock(identity: { provider: string; modelId: string }) {
  return new MockLanguageModelV3({
    ...identity,
    doGenerate: [
      {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const },
        usage: NO_USAGE,
        warnings: [],
      },
    ],
  });
}

describe("portableReasoning", () => {
  const providers = [{ id: "xd", name: "XD", agents: {} }];

  it("sends a settings-page provider's model the level as the SDK's own reasoning setting", () => {
    expect(portableReasoning("xd:codex/gpt-6", providers, { effort: "high" })).toBe("high");
    // 「不指定」 reaches here as no effort at all.
    expect(portableReasoning("xd:codex/gpt-6", providers, {})).toBeUndefined();
    // A level the portable setting does not have is dropped rather than sent.
    expect(portableReasoning("xd:codex/gpt-6", providers, { effort: "max" })).toBeUndefined();
  });

  it("leaves every other model to the path it already had", () => {
    expect(portableReasoning("codex-subscription:gpt-5.5", providers, { effort: "high" })).toBeUndefined();
    expect(portableReasoning("openai/gpt-5.5", providers, { effort: "high" })).toBeUndefined();
    expect(portableReasoning("other:model", providers, { effort: "high" })).toBeUndefined();
  });
});

describe("reasoning options", () => {
  it("always asks a codex model for a reasoning summary, and carries the effort when there is one", () => {
    expect(reasoningProviderOptions("codex-subscription:gpt-5.5")).toEqual({ openai: { reasoningSummary: "auto" } });
    expect(reasoningProviderOptions("codex-subscription:gpt-5.5", { effort: "high" })).toEqual({
      openai: { reasoningSummary: "auto", reasoningEffort: "high" },
    });
    expect(reasoningProviderOptions("openai/gpt-5.5", { effort: "low" })).toEqual({
      openai: { reasoningSummary: "auto", reasoningEffort: "low" },
    });
    expect(reasoningProviderOptions("codex-subscription:gpt-5.5", { summary: false })).toBeUndefined();
    // Fast rides in the same options, and only for a model that takes them.
    expect(reasoningProviderOptions("codex-subscription:gpt-5.5", { effort: "high" }, "priority")).toEqual({
      openai: { reasoningSummary: "auto", reasoningEffort: "high", serviceTier: "priority" },
    });
    expect(reasoningProviderOptions("anthropic/claude-sonnet-5", {}, "priority")).toBeUndefined();
  });

  it("leaves a non-OpenAI model alone", () => {
    expect(reasoningProviderOptions("anthropic/claude-sonnet-5", { effort: "high" })).toBeUndefined();
    expect(usesOpenAIReasoning(readThenAnswer("x"))).toBe(false);
  });

  it("reaches the model call: the agent sends reasoningSummary and the effort it was given", async () => {
    const model = answeringMock({ provider: "codex-subscription.responses", modelId: "gpt-5.5" });
    const { agent } = createVgentEngine({ model, repoPath, reasoning: { effort: "medium" } });

    await agent.generate({ prompt: "hi" });

    expect(model.doGenerateCalls[0]?.providerOptions).toEqual({
      openai: { reasoningSummary: "auto", reasoningEffort: "medium" },
    });
  });

  it("sends no provider options at all for a model that has no reasoning knob", async () => {
    const model = answeringMock({ provider: "anthropic.messages", modelId: "claude-sonnet-5" });
    const { agent } = createVgentEngine({ model, repoPath, reasoning: { effort: "medium" } });

    await agent.generate({ prompt: "hi" });

    expect(model.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });
});

describe("resolveModel", () => {
  it("passes a LanguageModel through untouched", () => {
    const model = readThenAnswer("x");
    expect(resolveModel(model)).toBe(model);
  });

  it("routes the codex-subscription prefix to the subscription provider", () => {
    const model = resolveModel("codex-subscription:gpt-5.5");
    expect(typeof model).not.toBe("string");
    expect((model as { modelId: string }).modelId).toBe("gpt-5.5");
  });

  it("rejects an empty codex-subscription model id", () => {
    expect(() => resolveModel("codex-subscription:")).toThrow(/缺少模型 id/);
  });

  it("routes a configured provider's prefix to that provider, and only when it is configured", () => {
    const providers = [
      {
        id: "deepseek",
        name: "DeepSeek",
        apiKey: "sk-test",
        agents: { vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible" as const, models: [{ id: "deepseek-v4-pro" }] } },
      },
    ];
    expect((resolveModel("deepseek:deepseek-v4-pro", providers) as { modelId: string }).modelId).toBe("deepseek-v4-pro");
    expect(() => resolveModel("deepseek:deepseek-v4-pro")).toThrow(/deepseek/);
  });

  it("routes anything else through the gateway as provider/model", () => {
    expect((resolveModel("openai/gpt-5") as { modelId: string }).modelId).toBe("openai/gpt-5");
    expect(() => resolveModel("not-a-spec")).toThrow(/模型标识不合法/);
  });
});
