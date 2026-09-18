import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolPath } from "../paths.js";
import { createGrepTool } from "./grep.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.each([
  ["ripgrep", true],
  ["pure-Node fallback", false],
])("grep tool (%s)", (_label, preferRg) => {
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

  it("skips directories even when the glob matches a directory name", async () => {
    await mkdir(join(workDir, "needle"), { recursive: true }); // a dir whose own name matches the search pattern
    const result = await makeTool().execute!({ pattern: "needle" }, execOptions);
    expect(result.matches.every((m: { file: string }) => m.file !== "needle")).toBe(true);
    expect(result.matches).toEqual([{ file: "a.ts", line: 1, text: "const needle = 1;" }]);
  });
});
