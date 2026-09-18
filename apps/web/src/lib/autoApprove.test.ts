import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { pendingAutoApprovals } from "./autoApprove";

const requested = (toolCallId: string, type: string, approvalId: string, input: unknown = {}): UIMessage["parts"][number] =>
  ({
    type,
    toolCallId,
    state: "approval-requested",
    input,
    approval: { id: approvalId },
  }) as unknown as UIMessage["parts"][number];

const assistant = (parts: UIMessage["parts"]): UIMessage => ({ id: "a1", role: "assistant", parts });

/** One pending `bash` approval for `command`, as the work log holds it. */
const bashCall = (command: string) => [assistant([requested("c1", "tool-bash", "ap1", { command })])];

describe("pendingAutoApprovals", () => {
  it("returns the approval ids of allowlisted tools only", () => {
    const messages = [
      assistant([
        { type: "text", text: "先看一下" },
        requested("c1", "tool-bash", "ap1", { command: "echo hi" }),
        requested("c2", "tool-write", "ap2"),
      ]),
    ];
    expect(pendingAutoApprovals(messages, ["bash(echo)"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(messages, ["bash(echo)", "write"])).toEqual(["ap1", "ap2"]);
    expect(pendingAutoApprovals(messages, ["write"])).toEqual(["ap2"]);
  });

  it("answers bash per command, the same way the engine does", () => {
    expect(pendingAutoApprovals(bashCall("echo a && echo b"), ["bash(echo)"])).toEqual(["ap1"]);
    // The built-in safe list covers `git status`, so only `echo` needs an entry.
    expect(pendingAutoApprovals(bashCall("git status && echo b"), ["bash(echo)"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(bashCall("echo a && rm x"), ["bash(echo)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("rm -rf /"), ["bash(echo)"])).toEqual([]);
    // Unreadable commands are never pre-approved.
    expect(pendingAutoApprovals(bashCall("FOO=1 echo hi"), ["bash(echo)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("sudo echo hi"), ["bash(echo)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("echo $(rm x)"), ["bash(echo)"])).toEqual([]);
  });

  it("still honours a legacy bare `bash` entry", () => {
    expect(pendingAutoApprovals(bashCall("rm -rf /"), ["bash"])).toEqual(["ap1"]);
  });

  /**
   * This is the harness engines' only allowlist: they decide approvals inside
   * themselves, so the sub-command rule has to hold here as well as in the
   * engine's own `decideApproval`.
   */
  it("needs the sub-command for a composite head, and drops the legacy `bash(git)`", () => {
    expect(pendingAutoApprovals(bashCall("git push"), ["bash(git push)"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(bashCall("git push"), ["bash(git)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("git commit -m wip"), ["bash(git commit)"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(bashCall("git commit -m wip && git push"), ["bash(git commit)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("git -C /other push"), ["bash(git push)"])).toEqual([]);
    expect(pendingAutoApprovals(bashCall("docker compose up -d"), ["bash(docker compose)"])).toEqual(["ap1"]);
    expect(pendingAutoApprovals(bashCall("docker rm -f box"), ["bash(docker compose)"])).toEqual([]);
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
      input: { command: "echo hi" },
      approval: { id: "ap1", approved: true },
    } as unknown as UIMessage["parts"][number];
    expect(pendingAutoApprovals([assistant([answered])], ["bash(echo)"])).toEqual([]);
  });

  it("is empty without an allowlist", () => {
    expect(pendingAutoApprovals(bashCall("echo hi"), undefined)).toEqual([]);
    expect(pendingAutoApprovals(bashCall("echo hi"), [])).toEqual([]);
  });
});
