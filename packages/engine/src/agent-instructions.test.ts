import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentInstructionsSection, loadAgentInstructions } from "./agent-instructions.js";

let root: string;
let home: string;
let project: string;
let worktree: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgent-agent-instructions-"));
  home = join(root, "home");
  project = join(root, "project");
  worktree = join(root, "worktree");
  await Promise.all([mkdir(join(home, ".claude"), { recursive: true }), mkdir(project, { recursive: true }), mkdir(worktree, { recursive: true })]);
});

describe("loadAgentInstructions", () => {
  it("reads global files first, then the project's, and takes a git-ignored file from the project checkout", async () => {
    await writeFile(join(home, ".claude", "CLAUDE.md"), "始终用中文回复。\n");
    await writeFile(join(project, "AGENTS.md"), "改完合到 main 再发 debug。");
    await writeFile(join(project, "CLAUDE.md"), "旧的项目说明");
    await writeFile(join(worktree, "CLAUDE.md"), "worktree 自己的项目说明");

    const files = await loadAgentInstructions({ repoPath: worktree, projectPath: project, home });

    expect(files).toEqual([
      { path: join(home, ".claude", "CLAUDE.md"), content: "始终用中文回复。" },
      { path: join(project, "AGENTS.md"), content: "改完合到 main 再发 debug。" },
      { path: join(worktree, "CLAUDE.md"), content: "worktree 自己的项目说明" },
    ]);
  });

  it("keeps identical text once and skips empty files", async () => {
    await writeFile(join(worktree, "AGENTS.md"), "same");
    await writeFile(join(worktree, "CLAUDE.md"), "same\n");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), "  \n");

    const files = await loadAgentInstructions({ repoPath: worktree, home });

    expect(files).toEqual([{ path: join(worktree, "AGENTS.md"), content: "same" }]);
  });

  it("renders nothing when there are no files", () => {
    expect(agentInstructionsSection([])).toBe("");
    expect(agentInstructionsSection([{ path: "/p/AGENTS.md", content: "rule" }])).toContain('<instructions path="/p/AGENTS.md">\nrule\n</instructions>');
  });
});
