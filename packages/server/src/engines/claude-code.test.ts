import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dynamicTool, isToolUIPart, jsonSchema, readUIMessageStream, simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { asHostTools, claudeCodeInstructions, hostToolApproval, withLongContext } from "./claude-code.js";

describe("claudeCodeInstructions", () => {
  it("hands Claude Code the global and the repository's AGENTS.md, then plan mode's rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vgent-claude-instructions-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    await mkdir(join(home, ".agents"), { recursive: true });
    await mkdir(repo);
    expect(await claudeCodeInstructions(repo, false, home)).toBeUndefined();

    await writeFile(join(home, ".agents", "AGENTS.md"), "始终用中文回复。");
    await writeFile(join(repo, "AGENTS.md"), "改完发 debug。");
    const plain = await claudeCodeInstructions(repo, false, home);
    expect(plain).toContain(`<instructions path="${join(home, ".agents", "AGENTS.md")}">\n始终用中文回复。`);
    expect(plain).toContain(`<instructions path="${join(repo, "AGENTS.md")}">\n改完发 debug。`);

    const planning = await claudeCodeInstructions(repo, true, home);
    expect(planning?.startsWith(plain!)).toBe(true);
    expect(planning!.length).toBeGreaterThan(plain!.length);
  });
});

describe("withLongContext", () => {
  it("asks for the long window on the model name, the way /model spells it", () => {
    expect(withLongContext("opus", 1_000_000)).toBe("opus[1m]");
    expect(withLongContext("anthropic-claude/claude-opus-5", 1_050_000)).toBe("anthropic-claude/claude-opus-5[1m]");
  });

  it("leaves the name alone for the standard window, for no choice, and when it already says so", () => {
    expect(withLongContext("opus", 200_000)).toBe("opus");
    expect(withLongContext("opus", undefined)).toBe("opus");
    expect(withLongContext("opus[1m]", 1_000_000)).toBe("opus[1m]");
  });
});

describe("hostToolApproval", () => {
  const tools = ["cua__list_windows", "cua__get_desktop_state", "cua__click", "cua__type_text", "cua__hotkey", "cua__launch_app"];

  it("lets the desktop be looked at, and asks before it is acted on, in 只读 and 自动改文件 alike", () => {
    for (const mode of ["allow-reads", "allow-edits"] as const) {
      expect(hostToolApproval(tools, { mode, alwaysAllow: [] }), mode).toEqual({
        cua__list_windows: "not-applicable",
        cua__get_desktop_state: "not-applicable",
        cua__click: "user-approval",
        cua__type_text: "user-approval",
        cua__hotkey: "user-approval",
        cua__launch_app: "user-approval",
      });
    }
  });

  it("asks nothing in 全自动", () => {
    const approval = hostToolApproval(tools, { mode: "allow-all", alwaysAllow: [] });
    expect(Object.values(approval).every((status) => status === "not-applicable")).toBe(true);
  });

  it("takes a standing 「一直允许」 of the tool as the answer, and only for that tool", () => {
    const approval = hostToolApproval(tools, { mode: "allow-reads", alwaysAllow: ["cua__click"] });
    expect(approval.cua__click).toBe("not-applicable");
    expect(approval.cua__type_text).toBe("user-approval");
  });

  it("does not let a tool the policy has not heard of through", () => {
    expect(hostToolApproval(["cua__something_new"], { mode: "allow-edits", alwaysAllow: [] })).toEqual({ cua__something_new: "user-approval" });
  });
});

describe("asHostTools", () => {
  it("hands MCP tools over as plain function tools, loaded up front", () => {
    const execute = async () => ({ content: [] });
    const tools = asHostTools({
      cua__launch_app: dynamicTool({ description: "launch", inputSchema: jsonSchema({ type: "object" }), execute }),
    });
    expect(tools.cua__launch_app).toMatchObject({ type: "function", deferLoading: false, description: "launch", execute });
  });

  /**
   * Regression: with a dynamic tool the harness's `tool-input-start` carried no
   * `dynamic` flag while its `tool-call` did, so one call became two parts and
   * the second never closed.
   */
  it("keeps one call one part in the UI stream", async () => {
    const tools = asHostTools({
      cua__list_windows: dynamicTool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "ok" }),
    });
    const dynamic = tools.cua__list_windows?.type === "dynamic";
    const chunks: UIMessageChunk[] = [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", toolCallId: "c1", toolName: "cua__list_windows" },
      { type: "tool-input-available", toolCallId: "c1", toolName: "cua__list_windows", input: { pid: 1 }, ...(dynamic ? { dynamic } : {}) },
      { type: "tool-output-available", toolCallId: "c1", output: "ok", ...(dynamic ? { dynamic } : {}) },
      { type: "finish-step" },
      { type: "finish" },
    ];
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream: simulateReadableStream({ chunks }) })) last = message;
    const parts = last?.parts.filter(isToolUIPart) ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.state).toBe("output-available");
  });
});
