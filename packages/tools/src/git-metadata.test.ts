import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodingTools } from "./index.js";
import { isInsideGitMetadata } from "./paths.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("isInsideGitMetadata", () => {
  it("recognises a .git directory or file at any depth below the root", () => {
    expect(isInsideGitMetadata("/repo", "/repo/.git")).toBe(true);
    expect(isInsideGitMetadata("/repo", "/repo/.git/config")).toBe(true);
    expect(isInsideGitMetadata("/repo", "/repo/vendor/lib/.git/hooks/pre-commit")).toBe(true);
  });

  it("does not care how the name is spelled: a case-insensitive volume has one .git under many names", () => {
    for (const path of ["/repo/.GIT/config", "/repo/.Git", "/repo/vendor/.gIT/hooks/pre-commit", "/repo/.g\u200cit/config", "/repo/.git\ufeff/config"]) {
      expect(isInsideGitMetadata("/repo", path), JSON.stringify(path)).toBe(true);
    }
  });

  it("folds the name wider than ASCII case and a fixed list of zero-width characters", () => {
    // Every default-ignorable code point, not only HFS+'s list; NFKC's fullwidth forms too.
    for (const path of ["/repo/.gi\u2060t/config", "/repo/.\u00adgit/config", "/repo/.gi\ufe0ft/hooks/x", "/repo/\uff0e\uff47\uff49\uff54/config", "/repo/.G\uff29T/config"]) {
      expect(isInsideGitMetadata("/repo", path), JSON.stringify(path)).toBe(true);
    }
  });

  it("leaves the files that merely look like git's alone", () => {
    for (const path of ["/repo", "/repo/.gitignore", "/repo/.gitattributes", "/repo/.github/workflows/ci.yml", "/repo/src/.gitkeep", "/repo/git/config"]) {
      expect(isInsideGitMetadata("/repo", path), path).toBe(false);
    }
  });

  it("says nothing about a path outside the root", () => {
    expect(isInsideGitMetadata("/repo", "/other/.git/config")).toBe(false);
  });
});

describe("createCodingTools: .git is not writable", () => {
  let workDir: string;
  const config = "[core]\n\tbare = false\n";
  const refusal = /inside a \.git directory/;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-git-")));
    await mkdir(join(workDir, ".git", "hooks"), { recursive: true });
    await writeFile(join(workDir, ".git", "config"), config);
    await mkdir(join(workDir, "vendor", "lib", ".git"), { recursive: true });
    await writeFile(join(workDir, "vendor", "lib", ".git", "config"), config);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("refuses to write inside .git, at the root or in a nested repository", async () => {
    const tools = createCodingTools({ workDir });
    for (const file_path of [".git/config", ".git/hooks/pre-commit", "vendor/lib/.git/config", join(workDir, ".git", "config")]) {
      await expect(
        tools.write!.execute!({ file_path, content: "[core]\n\tfsmonitor = /tmp/x.sh\n" }, execOptions),
        file_path,
      ).rejects.toThrow(refusal);
    }
    expect(await readFile(join(workDir, ".git", "config"), "utf8")).toBe(config);
  });

  it("refuses the same directory under another spelling of its name", async () => {
    const tools = createCodingTools({ workDir });
    for (const file_path of [".GIT/config", ".Git/hooks/pre-commit"]) {
      await expect(tools.write!.execute!({ file_path, content: "[core]\n\tfsmonitor = /tmp/x.sh\n" }, execOptions), file_path).rejects.toThrow(refusal);
    }
    expect(await readFile(join(workDir, ".git", "config"), "utf8")).toBe(config);
  });

  it("leaves nothing behind for a refused path", async () => {
    const tools = createCodingTools({ workDir });
    await expect(tools.write!.execute!({ file_path: ".git/new/dir/x", content: "x" }, execOptions)).rejects.toThrow(refusal);
    await expect(access(join(workDir, ".git", "new"))).rejects.toThrow();
  });

  it("refuses to edit inside .git", async () => {
    const tools = createCodingTools({ workDir });
    await expect(
      tools.edit!.execute!({ file_path: ".git/config", old_string: "bare = false", new_string: "fsmonitor = x" }, execOptions),
    ).rejects.toThrow(refusal);
    expect(await readFile(join(workDir, ".git", "config"), "utf8")).toBe(config);
  });

  it("refuses a path that only reaches .git through a symlink", async () => {
    await symlink(join(workDir, ".git"), join(workDir, "shortcut"));
    const tools = createCodingTools({ workDir });
    await expect(tools.write!.execute!({ file_path: "shortcut/config", content: "x" }, execOptions)).rejects.toThrow(refusal);
    expect(await readFile(join(workDir, ".git", "config"), "utf8")).toBe(config);
  });

  it("still writes the files that merely look like git's", async () => {
    const tools = createCodingTools({ workDir });
    for (const file_path of [".gitattributes", ".github/workflows/ci.yml", "src/.gitkeep"]) {
      const result = (await tools.write!.execute!({ file_path, content: "x\n" }, execOptions)) as { created: boolean };
      expect(result.created, file_path).toBe(true);
    }
  });

  it("still reads .git: only writing it is refused", async () => {
    const tools = createCodingTools({ workDir });
    const read = (await tools.read!.execute!({ file_path: ".git/config" }, execOptions)) as { content: string };
    expect(read.content).toContain("bare = false");
  });
});
