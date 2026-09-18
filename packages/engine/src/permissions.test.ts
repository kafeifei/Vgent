import { describe, expect, it } from "vitest";
import { createToolApproval, decideApproval } from "./permissions.js";

const bash = (mode: "allow-reads" | "allow-edits" | "allow-all", command: string) =>
  decideApproval({ mode, toolName: "bash", input: { command } });

describe("decideApproval", () => {
  it("never asks in allow-all", () => {
    for (const toolName of ["read", "grep", "glob", "write", "edit", "bash", "askUserQuestions", "somethingNew"]) {
      expect(decideApproval({ mode: "allow-all", toolName, input: { command: "rm -rf /" } })).toBe("not-applicable");
    }
  });

  it("lets read-only tools through in every mode", () => {
    for (const mode of ["allow-reads", "allow-edits"] as const) {
      for (const toolName of ["read", "grep", "glob"]) {
        expect(decideApproval({ mode, toolName, input: {} })).toBe("not-applicable");
      }
    }
  });

  it("asks before writes and edits in allow-reads but not in allow-edits", () => {
    for (const toolName of ["write", "edit"]) {
      expect(decideApproval({ mode: "allow-reads", toolName, input: {} })).toBe("user-approval");
      expect(decideApproval({ mode: "allow-edits", toolName, input: {} })).toBe("not-applicable");
    }
  });

  it("never asks before askUserQuestions, in any mode", () => {
    for (const mode of ["allow-reads", "allow-edits", "allow-all"] as const) {
      expect(decideApproval({ mode, toolName: "askUserQuestions", input: {} })).toBe("not-applicable");
    }
  });

  it("never asks before updatePlan, in any mode", () => {
    for (const mode of ["allow-reads", "allow-edits", "allow-all"] as const) {
      expect(decideApproval({ mode, toolName: "updatePlan", input: {} })).toBe("not-applicable");
    }
  });

  it("asks before every shell command in allow-reads, allowlist or not", () => {
    expect(bash("allow-reads", "git status")).toBe("user-approval");
    expect(bash("allow-reads", "rm -rf /")).toBe("user-approval");
  });

  it("treats an unknown tool as side-effecting", () => {
    expect(decideApproval({ mode: "allow-edits", toolName: "deployToProd", input: {} })).toBe("user-approval");
  });

  it("asks when bash input has no command string", () => {
    expect(decideApproval({ mode: "allow-edits", toolName: "bash", input: {} })).toBe("user-approval");
    expect(decideApproval({ mode: "allow-edits", toolName: "bash", input: null })).toBe("user-approval");
    expect(decideApproval({ mode: "allow-edits", toolName: "bash", input: { command: 42 } })).toBe("user-approval");
  });
});

describe("createToolApproval", () => {
  it("wires the decision into the shape toolApproval expects", () => {
    const approval = createToolApproval("allow-edits");
    expect(approval({ toolCall: { toolName: "bash", input: { command: "git status" } } })).toBe("not-applicable");
    expect(approval({ toolCall: { toolName: "bash", input: { command: "cat x; rm -rf /" } } })).toBe("user-approval");
    expect(approval({ toolCall: { toolName: "write", input: { file_path: "a" } } })).toBe("not-applicable");
  });
});

describe("alwaysAllow", () => {
  it("lets a listed tool through whatever the mode would have said", () => {
    expect(decideApproval({ mode: "allow-reads", toolName: "write", input: {}, alwaysAllow: ["write"] })).toBe("not-applicable");
    expect(decideApproval({ mode: "allow-reads", toolName: "somethingNew", input: {}, alwaysAllow: ["somethingNew"] })).toBe(
      "not-applicable",
    );
  });

  it("is command-scoped for bash: an entry names a command, not the whole shell", () => {
    expect(bash("allow-reads", "echo hi")).toBe("user-approval");
    const withEcho = (command: string) =>
      decideApproval({ mode: "allow-reads", toolName: "bash", input: { command }, alwaysAllow: ["bash(echo)"] });
    expect(withEcho("echo hi")).toBe("not-applicable");
    expect(withEcho("echo a && echo b")).toBe("not-applicable");
    expect(withEcho("echo a && rm x")).toBe("user-approval");
    expect(withEcho("rm -rf /")).toBe("user-approval");
  });

  /**
   * The same table the browser runs (`pendingAutoApprovals`), here on the
   * decision the in-house engine actually makes for its own `bash` tool.
   */
  it("needs the sub-command for a composite head, in every mode that asks", () => {
    const decide = (command: string, alwaysAllow: string[], mode: "allow-reads" | "allow-edits" = "allow-reads") =>
      decideApproval({ mode, toolName: "bash", input: { command }, alwaysAllow });

    expect(decide("git push", ["bash(git push)"])).toBe("not-applicable");
    // The legacy entry: it no longer answers anything.
    expect(decide("git push", ["bash(git)"])).toBe("user-approval");
    expect(decide("git push", ["bash(git status)"])).toBe("user-approval");
    expect(decide("git commit -m wip && git push", ["bash(git commit)"])).toBe("user-approval");
    expect(decide("git -C /other push", ["bash(git push)"])).toBe("user-approval");
    // 自动改文件 does not widen shell commands: they still go through the list.
    expect(decide("git push", ["bash(git)"], "allow-edits")).toBe("user-approval");
    expect(decide("git push", ["bash(git push)"], "allow-edits")).toBe("not-applicable");
  });

  it("leaves every other tool alone", () => {
    expect(decideApproval({ mode: "allow-reads", toolName: "write", input: {}, alwaysAllow: ["bash(rm)"] })).toBe("user-approval");
    expect(decideApproval({ mode: "allow-reads", toolName: "write", input: {}, alwaysAllow: [] })).toBe("user-approval");
  });

  it("reaches the agent through createToolApproval's second argument", () => {
    const approval = createToolApproval("allow-reads", ["bash(rm)"]);
    expect(approval({ toolCall: { toolName: "bash", input: { command: "rm -rf /" } } })).toBe("not-applicable");
    expect(approval({ toolCall: { toolName: "write", input: {} } })).toBe("user-approval");
  });
});
