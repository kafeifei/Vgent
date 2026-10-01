import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { agentInstructionsSection, loadAgentInstructions, loadScopedInstructions } from "./agent-instructions.js";

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

  it("does not read an instructions file that is a symlink out of the repository", async () => {
    // Read, this would put a credential into the prompt on the first turn.
    await writeFile(join(root, "secret.json"), '{"access_token":"sk-secret"}');
    await symlink(join(root, "secret.json"), join(repo, "AGENTS.md"));

    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([]);
  });

  it("still follows a symlink that stays inside the repository", async () => {
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "docs", "rules.md"), "the rules");
    await symlink(join(repo, "docs", "rules.md"), join(repo, "AGENTS.md"));

    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([{ path: join(repo, "AGENTS.md"), content: "the rules" }]);
  });

  it("follows the user's own global file wherever it points", async () => {
    await mkdir(join(root, "dotfiles"));
    await writeFile(join(root, "dotfiles", "AGENTS.md"), "始终用中文回复。");
    await symlink(join(root, "dotfiles", "AGENTS.md"), join(home, ".agents", "AGENTS.md"));

    expect(await loadAgentInstructions({ repoPath: repo, home })).toEqual([{ path: join(home, ".agents", "AGENTS.md"), content: "始终用中文回复。" }]);
  });

  it("renders nothing when there are no files", () => {
    expect(agentInstructionsSection([])).toBe("");
    expect(agentInstructionsSection([{ path: "/p/AGENTS.md", content: "rule" }])).toContain('<instructions path="/p/AGENTS.md">\nrule\n</instructions>');
  });
});

describe("loadScopedInstructions", () => {
  it("reads a directory's AGENTS.md for a file accessed below it", async () => {
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "file.ts"), "");
    await writeFile(join(repo, "sub", "AGENTS.md"), "sub rules");

    const rules = await loadScopedInstructions(repo, [join(repo, "sub", "file.ts")]);
    expect(rules.map((rule) => rule.content)).toEqual(["sub rules"]);
  });

  it("does not read a scoped rule that is a symlink out of the repository", async () => {
    await mkdir(join(repo, "sub"));
    await writeFile(join(repo, "sub", "file.ts"), "");
    await writeFile(join(root, "secret.json"), '{"access_token":"sk-secret"}');
    await symlink(join(root, "secret.json"), join(repo, "sub", "AGENTS.md"));

    expect(await loadScopedInstructions(repo, [join(repo, "sub", "file.ts")])).toEqual([]);
  });
});
