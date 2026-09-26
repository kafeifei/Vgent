import { describe, expect, it } from "vitest";
import { createAgentSetup } from "./agent-setup.js";
import { planModeInstructions } from "./instructions.js";

const base = { repoPath: "/repo", permissionMode: "allow-edits" as const };

describe("assembled instructions", () => {
  it("uses host-supplied identity and worktree facts without claiming the checkout is confined", () => {
    const { instructions: text } = createAgentSetup({
      ...base,
      repoPath: "/data/worktrees/t1",
      projectPath: "/home/me/project",
      context: {
        modelId: "codex-subscription:gpt-5.5",
        host: "Vgent desktop app (macOS)",
        workspace: { branch: "vgent/t1", baseCommit: "abc1234" },
      },
    });
    for (const fact of ["codex-subscription:gpt-5.5", "Vgent desktop app (macOS)", "/home/me/project", "vgent/t1", "abc1234", "git worktree list"])
      expect(text).toContain(fact);
    expect(text).not.toContain("Edits here never touch");
  });

  it("distinguishes project, scratch and unknown workspace metadata", () => {
    expect(createAgentSetup({ ...base, context: { workspaceKind: "project" } }).instructions).toContain("project's own working directory");
    expect(createAgentSetup({ ...base, context: { workspaceKind: "scratch" } }).instructions).toContain("scratch workspace with no attached project");
    const unknown = createAgentSetup(base).instructions;
    expect(unknown).toContain("No project or worktree metadata was supplied");
    expect(unknown).not.toContain("main working tree");
  });

  it("uses only selected tools and keeps child reporting separate from the parent final reply", () => {
    const child = createAgentSetup({ ...base, allowedTools: ["read", "grep", "glob"], interactive: false, role: "Report findings to the parent." });
    expect(Object.keys(child.tools)).toEqual(["read", "grep", "glob"]);
    expect(child.instructions).toContain("Available tools: read, grep, glob.");
    expect(child.instructions).toContain("Report findings to the parent.");
    expect(child.instructions).not.toContain("When you are done");
    expect(child.instructions).not.toContain("Command-dependent approval");
    expect(child.instructions).not.toContain("askUserQuestions");
  });

  it("retains shared plan-document guidance without claiming an absent question tool is available", () => {
    const planning = createAgentSetup({ ...base, plan: true, allowedTools: ["read", "grep", "glob"] });
    expect(planning.instructions).toContain("Plan mode.");
    expect(planning.instructions).toContain("saved verbatim as this task's plan document");
    expect(planning.instructions).toContain("Ask in plain text and stop");
    expect(createAgentSetup(base).instructions).not.toContain("Plan mode.");
    expect(planModeInstructions({ askTool: true })).toContain("`askUserQuestions`");
  });
});
