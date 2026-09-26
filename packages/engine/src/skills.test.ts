import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentSetup } from "./agent-setup.js";
import { loadSkillsIndex, parseSkillFrontmatter } from "./skills.js";

let root: string;

const writeSkill = async (dir: string, folder: string, body: string) => {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, "SKILL.md"), body);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgent-skills-"));
});

describe("loadSkillsIndex", () => {
  it("indexes frontmatter, falls back to the folder name, and ignores missing directories", async () => {
    const dir = join(root, "skills");
    await writeSkill(dir, "ai-sdk", `---\nname: ai-sdk\ndescription: "Write AI SDK v7 code."\n---\n\n# Body\n正文不进索引。\n`);
    await writeSkill(dir, "release-notes", "# Release notes\n没有 frontmatter。\n");
    await mkdir(join(dir, "not-a-skill"), { recursive: true });

    const index = await loadSkillsIndex([dir, join(root, "nope")]);

    expect(index).toEqual([
      { name: "ai-sdk", description: "Write AI SDK v7 code.", path: join(dir, "ai-sdk", "SKILL.md") },
      { name: "release-notes", description: "", path: join(dir, "release-notes", "SKILL.md") },
    ]);
  });

  it("lets an earlier directory shadow a later one of the same name", async () => {
    const repo = join(root, "repo");
    const user = join(root, "user");
    await writeSkill(repo, "deploy", "---\nname: deploy\ndescription: 仓库自己的。\n---\n");
    await writeSkill(user, "deploy", "---\nname: deploy\ndescription: 全局的。\n---\n");

    const index = await loadSkillsIndex([repo, user]);

    expect(index).toHaveLength(1);
    expect(index[0]?.description).toBe("仓库自己的。");
  });
});

describe("parseSkillFrontmatter", () => {
  it("reads quoted and unquoted scalars and stops at the closing fence", () => {
    expect(parseSkillFrontmatter("---\nname: 'a'\ndescription: b c\n---\nname: not-this\n")).toEqual({
      name: "a",
      description: "b c",
    });
    expect(parseSkillFrontmatter("# no frontmatter\nname: x\n")).toEqual({});
  });
});

describe("skill context", () => {
  it("renders the skills index and points at the SKILL.md", () => {
    const { instructions: text } = createAgentSetup({
      repoPath: "/repo",
      permissionMode: "allow-edits",
      skills: [
        { name: "ai-sdk", description: "Write AI SDK v7 code.", path: "/repo/.claude/skills/ai-sdk/SKILL.md" },
        { name: "release-notes", description: "", path: "/repo/.claude/skills/release-notes/SKILL.md" },
      ],
    });

    expect(text).toContain("ai-sdk: Write AI SDK v7 code.（/repo/.claude/skills/ai-sdk/SKILL.md）");
    expect(text).toContain("release-notes");
    expect(text).toContain("SKILL.md before relying on it");
  });

  it("omits the skill index when no enabled tool can read it", () => {
    const { instructions } = createAgentSetup({
      repoPath: "/repo", permissionMode: "allow-edits", allowedTools: [],
      skills: [{ name: "hidden-skill", description: "Unavailable", path: "/skills/hidden/SKILL.md" }],
    });
    expect(instructions).not.toContain("hidden-skill");
  });
});
