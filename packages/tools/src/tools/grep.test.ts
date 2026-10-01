import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolPath } from "../paths.js";
import { createGrepTool } from "./grep.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const hasRipgrep = spawnSync("rg", ["--version"]).status === 0;

// The same behaviour, once through ripgrep and once through the built-in walk. A
// machine without ripgrep reports the first as skipped rather than failing it.
describe.skipIf(!hasRipgrep)("grep tool (ripgrep)", () => grepSuite(true));
describe("grep tool (pure-Node fallback)", () => grepSuite(false));

function grepSuite(preferRg: boolean): void {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-grep-")));
    await mkdir(join(workDir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(workDir, "node_modules", "dep", "index.js"), "needle\n");
    await writeFile(join(workDir, "a.ts"), "const needle = 1;\nconst other = 2;\n");
    await writeFile(join(workDir, "b.txt"), "no match here\nNEEDLE upper\n");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createGrepTool({ workDir, resolveDir: (p) => resolveToolPath(workDir, p), preferRg });
  }

  it("finds matches with file/line/text and skips node_modules", async () => {
    const result = await makeTool().execute!({ pattern: "needle" }, execOptions);
    expect(result.usedRipgrep).toBe(preferRg);
    expect(result.matches).toEqual([{ file: "a.ts", line: 1, text: "const needle = 1;" }]);
  });

  it("supports case-insensitive search", async () => {
    const result = await makeTool().execute!({ pattern: "needle", case_insensitive: true }, execOptions);
    const files = result.matches.map((m: { file: string }) => m.file).sort();
    expect(files).toEqual(["a.ts", "b.txt"]);
  });

  it("filters by glob", async () => {
    const result = await makeTool().execute!({ pattern: "needle", case_insensitive: true, glob: "*.txt" }, execOptions);
    expect(result.matches).toEqual([{ file: "b.txt", line: 2, text: "NEEDLE upper" }]);
  });

  it("caps results at max_results and reports truncated", async () => {
    await writeFile(join(workDir, "many.txt"), Array.from({ length: 10 }, () => "needle").join("\n"));
    const result = await makeTool().execute!({ pattern: "needle", max_results: 3 }, execOptions);
    expect(result.matches.length).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects an invalid regex pattern", async () => {
    if (preferRg) return; // ripgrep has its own regex engine/error surface; the invalid-pattern guard is the pure-Node path's.
    await expect(makeTool().execute!({ pattern: "(unclosed" }, execOptions)).rejects.toThrow(/Invalid pattern/);
  });

  it("does not search outside the directory through an absolute glob", async () => {
    const outside = join(dirname(workDir), `${workDir.split("/").pop()}-outside.txt`);
    await writeFile(outside, "needle outside\n");
    try {
      // Either refused outright (the walker) or matching nothing (ripgrep's globs are relative): never a hit outside.
      const outcome = await makeTool().execute!({ pattern: "needle", glob: outside }, execOptions).then(
        (result) => result.matches as { file: string }[],
        () => [] as { file: string }[],
      );
      expect(outcome).toEqual([]);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("does not read through a symlink that leaves the tree", async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-grep-elsewhere-")));
    try {
      await writeFile(join(elsewhere, "secret.txt"), "needle secret\n");
      await symlink(elsewhere, join(workDir, "link"));
      const result = await makeTool().execute!({ pattern: "needle" }, execOptions);
      expect(result.matches.map((m: { file: string }) => m.file)).toEqual(["a.ts"]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not read a file that is itself a symlink out of the tree, and does read one that stays inside", async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-grep-elsewhere-")));
    try {
      await writeFile(join(elsewhere, "secret.txt"), "needle secret\n");
      await symlink(join(elsewhere, "secret.txt"), join(workDir, "leak.txt"));
      await symlink(join(workDir, "a.ts"), join(workDir, "alias.ts"));
      const result = await makeTool().execute!({ pattern: "needle" }, execOptions);
      const files = result.matches.map((m: { file: string }) => m.file);
      expect(files).toContain("a.ts");
      expect(files).not.toContain("leak.txt");
      // The fallback follows a link that stays inside the tree; ripgrep does not follow links at all.
      if (!preferRg) expect(files).toContain("alias.ts");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("searches a directory whose name looks like an option, instead of parsing it as one", async () => {
    // Unprotected, `--pre=sh` would reach ripgrep as an option that runs a program over every file.
    await mkdir(join(workDir, "--pre=sh"));
    await writeFile(join(workDir, "--pre=sh", "odd.txt"), "needle in an oddly named directory\n");
    const result = await makeTool().execute!({ pattern: "needle", path: "--pre=sh" }, execOptions);
    expect(result.matches).toEqual([{ file: "--pre=sh/odd.txt", line: 1, text: "needle in an oddly named directory" }]);
  });

  it("skips directories even when the glob matches a directory name", async () => {
    await mkdir(join(workDir, "needle"), { recursive: true }); // a dir whose own name matches the search pattern
    const result = await makeTool().execute!({ pattern: "needle" }, execOptions);
    expect(result.matches.every((m: { file: string }) => m.file !== "needle")).toBe(true);
    expect(result.matches).toEqual([{ file: "a.ts", line: 1, text: "const needle = 1;" }]);
  });
}
