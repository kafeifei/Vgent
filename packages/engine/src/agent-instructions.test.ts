import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentInstructionsSection, loadAgentInstructions } from "./agent-instructions.js";

let root: string;
let home: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgent-agent-instructions-"));
  home = join(root, "home");
  repo = join(root, "repo");
  await Promise.all([join(home, ".agents"), join(home, ".claude"), join(home, ".codex"), repo].map((dir) => mkdir(dir, { recursive: true })));
});

describe("loadAgentInstructions", () => {
  it("reads the global AGENTS.md first, then the repository's", async () => {
    await writeFile(join(home, ".agents", "AGENTS.md"), "始终用中文回复。\n");
    await writeFile(join(repo, "AGENTS.md"), "改完合到 main 再发 debug。");

    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([
      { path: join(home, ".agents", "AGENTS.md"), content: "始终用中文回复。" },
      { path: join(repo, "AGENTS.md"), content: "改完合到 main 再发 debug。" },
    ]);
  });

  it("leaves each harness's own files to it", async () => {
    await writeFile(join(home, ".claude", "CLAUDE.md"), "Claude Code 的规矩");
    await writeFile(join(home, ".codex", "AGENTS.md"), "Codex 的规矩");
    await writeFile(join(repo, "CLAUDE.md"), "@AGENTS.md");

    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([]);
  });

  it("skips empty files", async () => {
    await writeFile(join(home, ".agents", "AGENTS.md"), "  \n");
    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([]);
  });

  it("renders nothing when there are no files", () => {
    expect(agentInstructionsSection([])).toBe("");
    expect(agentInstructionsSection([{ path: "/p/AGENTS.md", content: "rule" }])).toContain('<instructions path="/p/AGENTS.md">\nrule\n</instructions>');
  });
});
