import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalRunner } from "./local-runner.js";

describe("local runner output limit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vgent-runner-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops a runaway command, keeps the file within the limit and says so", async () => {
    const limit = 256 * 1024;
    const runner = createLocalRunner(dir, { outputDir: join(dir, "out"), maxOutputChars: 2_000, maxOutputBytes: limit });
    const started = Date.now();
    // `yes` never ends on its own: only the limit can stop it.
    const result = await runner.run({ command: "yes vgent" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.outputTruncated).toBe(true);
    expect(result.stderr).toContain("Output exceeded");
    expect(result.stdout.length).toBeLessThan(2_200); // the cap plus the truncation marker
    const size = (await stat(result.outputFiles!.stdout)).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(limit);
  });

  it("also stops a runaway command that has no storage directory", async () => {
    const runner = createLocalRunner(dir);
    // No file to fill, but the in-memory view and the CPU are just as unbounded: the default limit applies.
    const result = await runner.run({ command: "yes vgent" });
    expect(result.outputTruncated).toBe(true);
    expect(result.stderr).toContain("Output exceeded 64 MiB");
    expect(result.stdout.length).toBeLessThan(1_100_000);
  }, 30_000);

  it("leaves a command under the limit alone", async () => {
    const runner = createLocalRunner(dir, { outputDir: join(dir, "out"), maxOutputChars: 2_000, maxOutputBytes: 256 * 1024 });
    const result = await runner.run({ command: "echo hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.outputTruncated).toBe(false);
    expect(result.stderr).not.toContain("Output exceeded");
  });
});
