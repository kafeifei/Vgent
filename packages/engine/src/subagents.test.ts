import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { convertToModelMessages, simulateReadableStream, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { createVgentEngine } from "./engine.js";
import { decideApproval } from "./permissions.js";
import { createSubagentTools, summarizeSubagentMessage } from "./subagents.js";

const NO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, reasoning: undefined },
  totalTokens: undefined,
};

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "vgent-subagents-"));
  await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
});

const FINISH_TOOL_CALLS = {
  type: "finish" as const,
  finishReason: { unified: "tool-calls" as const },
  usage: NO_USAGE,
};
const FINISH_STOP = { type: "finish" as const, finishReason: { unified: "stop" as const }, usage: NO_USAGE };

/** One streamed step that calls a tool. */
const toolCallStep = (id: string, toolName: string, input: unknown): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-end", id },
  { type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
  FINISH_TOOL_CALLS,
];

/** One streamed step that answers with text. */
const textStep = (text: string): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  FINISH_STOP,
];

/** A child model: it streams, because subagents always run through `stream()`. */
const childModel = (steps: LanguageModelV3StreamPart[][]) =>
  new MockLanguageModelV3({
    doStream: steps.map((chunks) => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }) })),
  });

/** A parent model: it generates, because the tests drive it with `generate()`. */
const parentModel = (toolName: string, input: unknown, finalText: string) =>
  new MockLanguageModelV3({
    doGenerate: [
      {
        content: [{ type: "tool-call" as const, toolCallId: "parent-1", toolName, input: JSON.stringify(input) }],
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

describe("explore subagent", () => {
  it("runs a child agent and hands the parent its transcript as the tool output", async () => {
    const child = childModel([
      toolCallStep("child-1", "read", { file_path: "hello-vgent.txt" }),
      textStep("hello-vgent.txt 里写着 hello from vgent。"),
    ]);
    const { agent, tools } = createVgentEngine({
      model: parentModel("explore", { prompt: "谁写了 hello-vgent.txt？" }, "子代理说：hello from vgent"),
      subagentModel: child,
      repoPath,
      permissionMode: "allow-reads",
    });

    const result = await agent.generate({ prompt: "用 explore 查一下 hello-vgent.txt。" });

    expect(result.text).toBe("子代理说：hello from vgent");
    expect(result.toolCalls.map((call) => call.toolName)).toEqual(["explore"]);

    // The output is the child's own UIMessage: its `read` call and its answer.
    const output = result.toolResults[0]!.output as UIMessage;
    expect(Array.isArray(output.parts)).toBe(true);
    expect(output.parts.some((part) => part.type === "tool-read")).toBe(true);
    expect(output.parts.some((part) => part.type === "text")).toBe(true);
    // The child really ran the tool against the temp repo.
    expect(JSON.stringify(output.parts)).toContain("hello from vgent");

    // …and `convertToModelMessages` turns that transcript back into the one
    // paragraph the parent model was given, but only with the same tools.
    const uiMessages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "用 explore 查一下。" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-explore",
            toolCallId: "parent-1",
            state: "output-available",
            input: { prompt: "谁写了 hello-vgent.txt？" },
            output,
          },
        ],
      } as UIMessage,
    ];
    const modelMessages = await convertToModelMessages(uiMessages, { tools });
    const toolMessage = modelMessages.find((message) => message.role === "tool");
    expect(toolMessage?.content[0]).toMatchObject({
      type: "tool-result",
      output: { type: "text", value: expect.stringContaining('"status":"completed"') },
    });

    // Without the tools, the whole transcript would go to the model instead.
    const unsummarized = await convertToModelMessages(uiMessages);
    expect(JSON.stringify(unsummarized.find((message) => message.role === "tool"))).toContain("tool-read");
  });

  it("needs no approval in allow-reads, unlike coder", () => {
    expect(decideApproval({ mode: "allow-reads", toolName: "explore", input: {} })).toBe("not-applicable");
    expect(decideApproval({ mode: "allow-reads", toolName: "coder", input: {} })).toBe("user-approval");
    expect(decideApproval({ mode: "allow-edits", toolName: "coder", input: {} })).toBe("not-applicable");
  });
});

describe("coder subagent", () => {
  it("fails the child's write in allow-reads instead of asking, and writes nothing", async () => {
    const child = childModel([
      toolCallStep("child-1", "write", { file_path: "new-file.txt", content: "nope" }),
      textStep("写入被拒绝了。"),
    ]);
    const tools: ToolSet = createSubagentTools({ model: child, repoPath, permissionMode: "allow-reads" });

    // The tool's generator yields the child's message as it grows; the last one
    // is the tool's real output.
    const execute = tools.coder!.execute as (input: unknown, options: unknown) => AsyncIterable<UIMessage>;
    let last: UIMessage | undefined;
    for await (const message of execute({ task: "新建 new-file.txt" }, { toolCallId: "t1", messages: [] })) {
      last = message;
    }

    const failed = last?.parts.find((part) => part.type === "tool-write");
    expect(failed).toMatchObject({ state: "output-error" });
    expect((failed as { errorText?: string } | undefined)?.errorText).toContain("子代理不能执行需要审批的操作");
    expect(await readdir(repoPath)).toEqual(["hello-vgent.txt"]);
  });

  it("runs bash for the child when the parent's alwaysAllow covers it, even in allow-reads", async () => {
    const child = childModel([toolCallStep("child-1", "bash", { command: "echo ok" }), textStep("跑完了。")]);
    const tools: ToolSet = createSubagentTools({
      model: child,
      repoPath,
      permissionMode: "allow-reads",
      // Command-scoped, like the real list: the child gets `echo`, nothing else.
      alwaysAllow: ["bash(echo)"],
    });

    const execute = tools.coder!.execute as (input: unknown, options: unknown) => AsyncIterable<UIMessage>;
    let last: UIMessage | undefined;
    for await (const message of execute({ task: "跑一下 echo ok" }, { toolCallId: "t1", messages: [] })) {
      last = message;
    }

    const bashPart = last?.parts.find((part) => part.type === "tool-bash");
    expect(bashPart).toMatchObject({ state: "output-available" });
    expect(JSON.stringify(bashPart)).not.toContain("子代理不能执行需要审批的操作");
    expect(JSON.stringify(bashPart)).toContain("ok");
  });
});

describe("summarizeSubagentMessage", () => {
  it("takes the last text part and says so when there is none", () => {
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        { type: "text", text: "第一段" },
        { type: "text", text: "  最后一段  " },
      ],
    } as UIMessage;
    expect(summarizeSubagentMessage(message)).toBe("最后一段");
    expect(summarizeSubagentMessage(undefined)).toContain("子代理没有返回文本。");
    expect(summarizeSubagentMessage({ id: "m", role: "assistant", parts: [] } as UIMessage)).toContain("子代理没有返回文本。");
  });

  it("truncates a long summary and marks it", () => {
    const message = { id: "m", role: "assistant", parts: [{ type: "text", text: "x".repeat(5000) }] } as UIMessage;
    const summary = summarizeSubagentMessage(message);
    expect(summary.length).toBeLessThan(5000);
    expect(summary).toContain("摘要已截断");
  });
});

describe("child result contract", () => {
  it("preserves a full report reference and gives the parent a bounded summary including its risk", async () => {
    const child = new MockLanguageModelV3({
      doStream: {
        stream: simulateReadableStream({
          chunks: textStep("details ".repeat(1500) + "RISK: migration is still pending"),
          chunkDelayInMs: null,
          initialDelayInMs: null,
        }),
      },
      doGenerate: {
        content: [{ type: "text", text: "Found files. RISK: migration is still pending; do not declare delivery complete." }],
        finishReason: { unified: "stop" },
        usage: NO_USAGE,
        warnings: [],
      },
    });
    const tools = createSubagentTools({
      model: child,
      repoPath,
      permissionMode: "allow-reads",
      instructions: "ROOT_CONSTRAINT_SENTINEL",
      outputDir: join(repoPath, ".reports"),
    });
    let output: UIMessage | undefined;
    for await (const value of tools.explore!.execute!(
      { prompt: "Research migration" },
      { toolCallId: "child", messages: [] },
    ) as AsyncIterable<UIMessage>)
      output = value;
    const result = JSON.parse(summarizeSubagentMessage(output));
    expect(result.summary).toContain("RISK: migration is still pending");
    expect(result.summary.length).toBeLessThan(4000);
    expect(typeof result.details).toBe("string");
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(result.details, "utf8")).length).toBeGreaterThan(10000);
    expect(JSON.stringify(child.doStreamCalls[0]!.prompt)).toContain("ROOT_CONSTRAINT_SENTINEL");
  });
  it("marks an empty final reply incomplete, even though the tool produced a transcript", async () => {
    const tools = createSubagentTools({ model: childModel([textStep(" ")]), repoPath, permissionMode: "allow-reads" });
    let output: UIMessage | undefined;
    for await (const value of tools.explore!.execute!(
      { prompt: "Inspect" },
      { toolCallId: "child", messages: [] },
    ) as AsyncIterable<UIMessage>)
      output = value;
    expect(JSON.parse(summarizeSubagentMessage(output))).toMatchObject({ status: "incomplete", stopReason: "empty" });
  });
});

it("resumes a child by its durable ID with the prior delegated request and response", async () => {
  const child = childModel([textStep("First finding: KEEP-832"), textStep("Continued using KEEP-832")]);
  const tools = createSubagentTools({ model: child, repoPath, permissionMode: "allow-reads", outputDir: join(repoPath, ".reports") });
  const execute = tools.explore!.execute as (input: unknown, options: unknown) => AsyncIterable<UIMessage>;
  let first: UIMessage | undefined;
  for await (const value of execute({ prompt: "Find KEEP-832" }, { toolCallId: "one", messages: [] })) first = value;
  const taskId = JSON.parse(summarizeSubagentMessage(first)).taskId;
  let second: UIMessage | undefined;
  for await (const value of execute(
    { prompt: "Continue from the earlier finding", resume_task_id: taskId },
    { toolCallId: "two", messages: [] },
  ))
    second = value;
  expect(JSON.parse(summarizeSubagentMessage(second)).taskId).toBe(taskId);
  expect(JSON.stringify(child.doStreamCalls[1]!.prompt)).toContain("First finding: KEEP-832");
  expect(JSON.stringify(child.doStreamCalls[1]!.prompt)).toContain("verify uncertain prior side effects");
});

it("passes the same project and skill capabilities into the child's actual model request and tool execution", async () => {
  const { mkdir, readFile, rm } = await import("node:fs/promises");
  const projectPath = await mkdtemp(join(tmpdir(), "vgent-parent-project-"));
  const skillDir = join(projectPath, "skills", "delivery");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "DELIVERY_SKILL_SENTINEL");
  const delivered = join(projectPath, "delivered.txt");
  try {
    const child = childModel([
      toolCallStep("child-read", "read", { file_path: join(skillDir, "SKILL.md") }),
      toolCallStep("child-write", "write", { file_path: delivered, content: "verified delivery" }),
      textStep("Created delivered.txt in the project checkout."),
    ]);
    const parent = parentModel("coder", { task: "Read the delivery skill and create delivered.txt in the project checkout." }, "Delivered.");
    const engine = createVgentEngine({
      model: parent, subagentModel: child, repoPath, projectPath,
      permissionMode: "allow-reads", alwaysAllow: ["coder", "write"],
      context: { host: "Vgent test host", workspace: { branch: "task-branch", baseCommit: "base123" } },
      skills: [{ name: "delivery", description: "Delivery process", path: join(skillDir, "SKILL.md") }],
      instructions: "PROJECT_RULE_SENTINEL: preserve unrelated changes.",
    });
    await engine.agent.generate({ prompt: "Delegate the delivery step." });
    expect(await readFile(delivered, "utf8")).toBe("verified delivery");
    const prompt = JSON.stringify(child.doStreamCalls[0]!.prompt);
    for (const fact of ["Vgent test host", "task-branch", "base123", "PROJECT_RULE_SENTINEL", projectPath, "delivery", "allow-reads"])
      expect(prompt).toContain(fact);
    expect(prompt).toContain("Run without tool approval: read, write, grep, glob");
    expect(prompt).toContain("are denied in this subagent");
    expect(prompt).not.toContain("Available tools: read, write, edit, bash, grep, glob, coder");
    for (const name of ["read", "write", "bash"]) {
      const description = (call: { tools?: readonly { name?: string; description?: string }[] }) => call.tools?.find((tool) => tool.name === name)?.description;
      expect(description(child.doStreamCalls[0]!)).toBe(description(parent.doGenerateCalls[0]!));
    }
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
