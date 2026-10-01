import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolPath } from "../paths.js";
import { createGlobTool } from "./glob.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("glob tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-glob-")));
    await mkdir(join(workDir, "src", "a"), { recursive: true });
    await mkdir(join(workDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workDir, "src", "index.ts"), "");
    await writeFile(join(workDir, "src", "a", "x.ts"), "");
    await writeFile(join(workDir, "src", "a", "y.js"), "");
    await writeFile(join(workDir, "node_modules", "pkg", "z.ts"), "");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createGlobTool({ workDir, resolveDir: (p) => resolveToolPath(workDir, p) });
  }

  it("finds files matching a pattern, sorted, skipping node_modules", async () => {
    const result = await makeTool().execute!({ pattern: "**/*.ts" }, execOptions);
    expect(result.paths).toEqual(["src/a/x.ts", "src/index.ts"]);
    expect(result.truncated).toBe(false);
  });

  it("searches under a given path", async () => {
    const result = await makeTool().execute!({ pattern: "*.ts", path: "src/a" }, execOptions);
    expect(result.paths).toEqual(["src/a/x.ts"]);
  });

  it("rejects a search path outside the working directory", async () => {
    await expect(makeTool().execute!({ pattern: "*", path: "../escape" }, execOptions)).rejects.toThrow(/outside the working directory/);
  });

  it("rejects a pattern that leaves the search directory", async () => {
    // fs.promises.glob would match these wherever they point, `cwd` or not.
    for (const pattern of [join(workDir, "src", "*"), "/etc/*", "../*", "src/../../*", "**/../*"]) {
      await expect(makeTool().execute!({ pattern }, execOptions), pattern).rejects.toThrow(/must be relative/);
    }
  });

  it("includes matching directories, marked with a trailing slash", async () => {
    const result = await makeTool().execute!({ pattern: "*" }, execOptions);
    expect(result.paths).toEqual(["src/"]);
  });

  it("lists subdirectories for a dir/* pattern", async () => {
    const result = await makeTool().execute!({ pattern: "src/*" }, execOptions);
    expect(result.paths).toEqual(["src/a/", "src/index.ts"]);
  });
});
