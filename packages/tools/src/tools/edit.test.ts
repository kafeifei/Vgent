import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../fs.js";
import { resolveToolPath } from "../paths.js";
import { createEditTool } from "./edit.js";

const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("edit tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-edit-")));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createEditTool({ fs: createNodeFileSystem(), resolvePath: (p) => resolveToolPath(workDir, p) });
  }

  it("replaces a unique match and returns a diff", async () => {
    await writeFile(join(workDir, "a.txt"), "line1\nline2\nline3\n");
    const result = await makeTool().execute!({ file_path: "a.txt", old_string: "line2", new_string: "LINE_TWO" }, execOptions);
    expect(result.replacements).toBe(1);
    expect(result.diff).toContain("-line2");
    expect(result.diff).toContain("+LINE_TWO");
    await expect(readFile(join(workDir, "a.txt"), "utf8")).resolves.toBe("line1\nLINE_TWO\nline3\n");
  });

  it("replaces every occurrence when replace_all is set", async () => {
    await writeFile(join(workDir, "a.txt"), "foo\nfoo\nfoo\n");
    const result = await makeTool().execute!({ file_path: "a.txt", old_string: "foo", new_string: "bar", replace_all: true }, execOptions);
    expect(result.replacements).toBe(3);
    await expect(readFile(join(workDir, "a.txt"), "utf8")).resolves.toBe("bar\nbar\nbar\n");
  });

  it("throws when old_string has zero matches", async () => {
    await writeFile(join(workDir, "a.txt"), "hello\n");
    await expect(makeTool().execute!({ file_path: "a.txt", old_string: "missing", new_string: "x" }, execOptions)).rejects.toThrow(/0 matches/);
  });

  it("throws when old_string is not unique and replace_all is not set", async () => {
    await writeFile(join(workDir, "a.txt"), "dup\ndup\n");
    await expect(makeTool().execute!({ file_path: "a.txt", old_string: "dup", new_string: "x" }, execOptions)).rejects.toThrow(/2 matches/);
  });

  it("throws for a missing file", async () => {
    await expect(makeTool().execute!({ file_path: "missing.txt", old_string: "a", new_string: "b" }, execOptions)).rejects.toThrow(/not found/);
  });
});
