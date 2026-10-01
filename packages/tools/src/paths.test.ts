import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldFileName, resolveToolPath } from "./paths.js";

describe("resolveToolPath", () => {
  let workDir: string;

  beforeEach(async () => {
    // Canonicalize: on macOS, os.tmpdir() lives under a symlinked prefix
    // (/var -> /private/var), and resolveToolPath always returns realpaths.
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-paths-")));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves a relative path inside the working directory", async () => {
    await writeFile(join(workDir, "a.txt"), "hi");
    await expect(resolveToolPath(workDir, "a.txt")).resolves.toBe(join(workDir, "a.txt"));
  });

  it("resolves an absolute path inside the working directory", async () => {
    await writeFile(join(workDir, "a.txt"), "hi");
    await expect(resolveToolPath(workDir, join(workDir, "a.txt"))).resolves.toBe(join(workDir, "a.txt"));
  });

  it("allows a path that does not exist yet, as long as it stays inside the working directory", async () => {
    await expect(resolveToolPath(workDir, "new/nested/file.txt")).resolves.toBe(join(workDir, "new/nested/file.txt"));
  });

  it("rejects a path that escapes via ..", async () => {
    await expect(resolveToolPath(workDir, "../outside.txt")).rejects.toThrow(/outside the working directory/);
  });

  it("rejects a path that escapes through a symlinked ancestor", async () => {
    await symlink("/etc", join(workDir, "evil"));
    await expect(resolveToolPath(workDir, "evil/passwd")).rejects.toThrow(/symlink/);
  });

  it("rejects a dangling symlink", async () => {
    await symlink(join(workDir, "does-not-exist"), join(workDir, "dangling"));
    await expect(resolveToolPath(workDir, "dangling")).rejects.toThrow(/dangling symlink/);
  });

  it("rejects a dangling symlink nested under a real directory", async () => {
    await mkdir(join(workDir, "sub"));
    await symlink(join(workDir, "sub", "missing-target"), join(workDir, "sub", "dangling"));
    await expect(resolveToolPath(workDir, "sub/dangling")).rejects.toThrow(/dangling symlink/);
  });

  it("allows escaping the working directory when allowOutsideWorkDir is set", async () => {
    const resolved = await resolveToolPath(workDir, "../outside.txt", { allowOutsideWorkDir: true });
    expect(resolved.endsWith("outside.txt")).toBe(true);
  });
});

describe("foldFileName", () => {
  it("folds what a macOS volume folds: Unicode case, NFC vs NFD, and HFS+'s ignored code points", () => {
    const same: [string, string][] = [
      ["worktreeſ.json", "worktrees.json"], // long s
      ["wor\u212atrees.json", "worktrees.json"], // Kelvin sign
      ["WORKTREES.JSON", "worktrees.json"],
      ["groß", "gross"],
      ["groẞ", "gross"],
      ["ﬅack", "stack"], // the `st` ligature
      ["café", "cafe\u0301"], // precomposed and combining
      [".g\u200cit", ".git"],
      [".git\ufeff", ".git"],
      [".gi\u2060t", ".git"],
      // Wider than any volume, on purpose: fullwidth forms are not a way around a guard.
      ["．ｇｉｔ", ".git"],
    ];
    for (const [spelled, plain] of same) {
      expect(foldFileName(spelled), JSON.stringify(spelled)).toBe(foldFileName(plain));
    }
  });

  it("keeps names apart that are different names", () => {
    for (const [a, b] of [["worktree\u0301s.json", "worktrees.json"], [".gitignore", ".git"], ["a／b", "a"], ["é", "e"]]) {
      expect(foldFileName(a), JSON.stringify(a)).not.toBe(foldFileName(b));
    }
  });

  it("is idempotent", () => {
    for (const name of ["groẞ", "İstanbul", "worktreeſ.json", "．ｇｉｔ"]) {
      expect(foldFileName(foldFileName(name))).toBe(foldFileName(name));
    }
  });

  it("folds together every spelling this filesystem resolves to the same file", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-fold-")));
    try {
      await writeFile(join(dir, "worktrees.json"), "");
      await writeFile(join(dir, "gross"), "");
      await writeFile(join(dir, "café"), "");
      const spellings: [string, string][] = [
        ["worktreeſ.json", "worktrees.json"],
        ["wor\u212atrees.json", "worktrees.json"],
        ["WORKTREES.JSON", "worktrees.json"],
        ["groß", "gross"],
        ["groẞ", "gross"],
        ["cafe\u0301", "café"],
        ["CAFÉ", "café"],
        ["worktrees.json\u200d", "worktrees.json"],
      ];
      // On macOS's default case-insensitive APFS all but the last are that file (HFS+
      // would ignore the last one's zero-width joiner instead); the loop below only
      // has something to say where the volume folds them.
      if (process.platform === "darwin" && existsSync(join(dir, "WORKTREES.JSON"))) {
        for (const [spelled] of spellings.slice(0, -1)) expect(existsSync(join(dir, spelled)), JSON.stringify(spelled)).toBe(true);
      }
      for (const [spelled, plain] of spellings) {
        if (existsSync(join(dir, spelled))) expect(foldFileName(spelled), JSON.stringify(spelled)).toBe(foldFileName(plain));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
