import { describe, expect, it } from "vitest";
import { buildInstructions } from "./instructions.js";

const base = { repoPath: "/repo", permissionMode: "allow-edits" as const };

describe("buildInstructions", () => {
  it("names the model and the host, and describes the worktree it is sitting in", () => {
    const text = buildInstructions({
      ...base,
      repoPath: "/data/worktrees/t1",
      context: {
        modelId: "codex-subscription:gpt-5.5",
        host: "Vgent desktop app (macOS)",
        workspace: {
          path: "/data/worktrees/t1",
          projectPath: "/home/me/project",
          branch: "vgent/t1",
          baseCommit: "abc1234",
        },
      },
    });

    expect(text).toContain("codex-subscription:gpt-5.5");
    expect(text).toContain("Vgent desktop app (macOS)");
    expect(text).toContain("dedicated git worktree of the project at `/home/me/project`");
    expect(text).toContain("vgent/t1");
    expect(text).toContain("abc1234");
    expect(text).toContain("git worktree list");
    expect(text).not.toContain("This is the project's main working tree.");
  });

  it("says the directory is the main working tree when no worktree is given", () => {
    const text = buildInstructions({ ...base, context: { modelId: "openai/gpt-5.5", host: "Vgent CLI" } });

    expect(text).toContain("This is the project's main working tree.");
    expect(text).toContain("openai/gpt-5.5");
    expect(text).not.toContain("dedicated git worktree");
  });

  it("falls back to the generic opening with no context at all", () => {
    const text = buildInstructions(base);

    expect(text).toContain("You are Vgent, a coding agent working directly in a user's repository.");
    expect(text).toContain("This is the project's main working tree.");
  });

  it("tells the model to check with tools before asking the user to explain a contradiction", () => {
    expect(buildInstructions(base)).toContain("investigate with tools (git, grep) before asking the");
  });
});
