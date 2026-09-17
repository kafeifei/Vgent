import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveToolPath } from "./paths.js";

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
