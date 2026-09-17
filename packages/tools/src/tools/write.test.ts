import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../fs.js";
import { resolveToolPath } from "../paths.js";
import { createWriteTool } from "./write.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("write tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-write-")));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool() {
    const fs = createNodeFileSystem();
    return createWriteTool({
      fs,
      resolvePath: async (p) => {
        const resolved = await resolveToolPath(workDir, p);
        await mkdir(dirname(resolved), { recursive: true });
        return resolveToolPath(workDir, p);
      },
    });
  }

  it("creates a new file, including parent directories", async () => {
    const result = await makeTool().execute!({ file_path: "nested/dir/a.txt", content: "hello" }, execOptions);
    expect(result).toEqual({ path: join(workDir, "nested/dir/a.txt"), bytes: 5, created: true });
    await expect(readFile(join(workDir, "nested/dir/a.txt"), "utf8")).resolves.toBe("hello");
  });

  it("overwrites an existing file and reports created: false", async () => {
    const tool = makeTool();
    await tool.execute!({ file_path: "a.txt", content: "one" }, execOptions);
    const result = await tool.execute!({ file_path: "a.txt", content: "two" }, execOptions);
    expect(result.created).toBe(false);
    await expect(readFile(join(workDir, "a.txt"), "utf8")).resolves.toBe("two");
  });

  it("rejects a path that escapes the working directory", async () => {
    await expect(makeTool().execute!({ file_path: "../escape.txt", content: "x" }, execOptions)).rejects.toThrow(/outside the working directory/);
  });
});
