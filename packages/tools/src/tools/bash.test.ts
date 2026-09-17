import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalRunner } from "../local-runner.js";
import { resolveToolPath } from "../paths.js";
import { createBashTool } from "./bash.js";

describe("bash tool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "vgent-tools-bash-")));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeTool(maxOutputChars = 30_000) {
    return createBashTool({
      runner: createLocalRunner(workDir),
      workDir,
      resolveDir: (p) => resolveToolPath(workDir, p),
      maxOutputChars,
    });
  }

  it("runs a command and returns its output", async () => {
    const result = await makeTool().execute!({ command: "echo hello" }, { toolCallId: "t1", messages: [] } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("returns a nonzero exit code without throwing", async () => {
    const result = await makeTool().execute!({ command: "exit 7" }, { toolCallId: "t1", messages: [] } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(result.exitCode).toBe(7);
  });

  it("runs in the requested working_directory", async () => {
    await mkdir(join(workDir, "sub"));
    const result = await makeTool().execute!({ command: "pwd", working_directory: "sub" }, { toolCallId: "t1", messages: [] } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(result.stdout.trim()).toBe(join(workDir, "sub"));
  });

  it("truncates output longer than maxOutputChars, keeping head and tail", async () => {
    const result = await makeTool(50).execute!(
      { command: "node -e \"process.stdout.write('x'.repeat(500))\"" },
      { toolCallId: "t1", messages: [] } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(500);
  });

  it("throws when the command exceeds its timeout", async () => {
    await expect(
      makeTool().execute!({ command: "sleep 5", timeout_ms: 100 }, { toolCallId: "t1", messages: [] } as any), // eslint-disable-line @typescript-eslint/no-explicit-any
    ).rejects.toThrow(/timed out/);
  }, 10_000);
});
