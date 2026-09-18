import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { pendingAutoApprovals } from "./autoApprove";

const requested = (toolCallId: string, type: string, approvalId: string): UIMessage["parts"][number] =>
  ({
    type,
    toolCallId,
    state: "approval-requested",
    input: {},
    approval: { id: approvalId },
  }) as unknown as UIMessage["parts"][number];

const assistant = (parts: UIMessage["parts"]): UIMessage => ({ id: "a1", role: "assistant", parts });

describe("pendingAutoApprovals", () => {
  it("returns the approval ids of allowlisted tools only", () => {
    const messages = [
      assistant([
        { type: "text", text: "先看一下" },
        requested("c1", "tool-bash", "ap1"),
        requested("c2", "tool-write", "ap2"),
      ]),
    ];
    expect(pendingAutoApprovals(messages, ["bash"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(messages, ["bash", "write"])).toEqual(["ap1", "ap2"]);
  });

  it("covers dynamic tools, which is how MCP tools arrive", () => {
    const part = {
      type: "dynamic-tool",
      toolName: "mcp__docs__search",
      toolCallId: "c3",
      state: "approval-requested",
      input: {},
      approval: { id: "ap3" },
    } as unknown as UIMessage["parts"][number];
    expect(pendingAutoApprovals([assistant([part])], ["mcp__docs__search"])).toEqual(["ap3"]);
  });

  it("ignores everything that is not waiting on the human", () => {
    const answered = {
      type: "tool-bash",
      toolCallId: "c1",
      state: "approval-responded",
      input: {},
      approval: { id: "ap1", approved: true },
    } as unknown as UIMessage["parts"][number];
    expect(pendingAutoApprovals([assistant([answered])], ["bash"])).toEqual([]);
  });

  it("is empty without an allowlist", () => {
    const messages = [assistant([requested("c1", "tool-bash", "ap1")])];
    expect(pendingAutoApprovals(messages, undefined)).toEqual([]);
    expect(pendingAutoApprovals(messages, [])).toEqual([]);
  });
});
