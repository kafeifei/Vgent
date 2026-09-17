import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../fs.js";
import { resolveToolPath } from "../paths.js";
import { createReadTool } from "./read.js";

// Minimal fixture for ToolExecutionOptions; none of these tools' logic under test reads it (except bash's abortSignal, set per-test).
const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("read tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-read-")));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createReadTool({ fs: createNodeFileSystem(), resolvePath: (p) => resolveToolPath(workDir, p) });
  }

  it("reads a file with cat -n style line numbers", async () => {
    await writeFile(join(workDir, "a.txt"), "one\ntwo\nthree");
    const result = await makeTool().execute!({ file_path: "a.txt" }, execOptions);
    expect(result).toEqual({
      path: join(workDir, "a.txt"),
      content: "     1\tone\n     2\ttwo\n     3\tthree",
      truncated: false,
      totalLines: 3,
    });
  });

  it("pages through a file with offset and limit", async () => {
    await writeFile(join(workDir, "a.txt"), Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n"));
    const result = await makeTool().execute!({ file_path: "a.txt", offset: 3, limit: 2 }, execOptions);
    expect(result.content).toBe("     3\tline-3\n     4\tline-4");
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(10);
  });

  it("rejects reading a binary file", async () => {
    await writeFile(join(workDir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x66, 0x6f, 0x6f]));
    await expect(makeTool().execute!({ file_path: "bin.dat" }, execOptions)).rejects.toThrow(/binary/);
  });

  it("rejects a file larger than 1 MiB", async () => {
    await writeFile(join(workDir, "big.txt"), "x".repeat(1024 * 1024 + 1));
    await expect(makeTool().execute!({ file_path: "big.txt" }, execOptions)).rejects.toThrow(/too large/);
  });

  it("rejects a missing file", async () => {
    await expect(makeTool().execute!({ file_path: "missing.txt" }, execOptions)).rejects.toThrow(/not found/);
  });
});
