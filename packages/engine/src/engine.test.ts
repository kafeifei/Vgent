import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3CallOptions, LanguageModelV3Usage } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createVgentEngine, resolveModel, type VgentEngineEvent } from "./engine.js";
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
    expect(() => resolveModel("codex-subscription:")).toThrow(/Missing model id/);
  });

  it("routes anything else through the gateway as provider/model", () => {
    expect((resolveModel("openai/gpt-5") as { modelId: string }).modelId).toBe("openai/gpt-5");
    expect(() => resolveModel("not-a-spec")).toThrow(/provider\/model/);
  });
});
