import { dynamicTool, isToolUIPart, jsonSchema, readUIMessageStream, simulateReadableStream, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { asHostTools, withLongContext } from "./claude-code.js";

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
