import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotTree } from "./checkpoints.js";
import { BadRequestError, NotAGitRepoError, NotFoundError } from "./errors.js";
import { createGit, type ChangedFile } from "./git.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-git-"));
  dirs.push(dir);
  return dir;
}

const run = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** A repo with `user.*` set locally, so it never depends on the machine's git identity. */
async function initRepo(): Promise<string> {
  const dir = await tempDir();
  await run(dir, "init", "-q", "-b", "main");
  await run(dir, "config", "user.email", "test@vgent.local");
  await run(dir, "config", "user.name", "Vgent Test");
  await run(dir, "config", "commit.gpgsign", "false");
  return dir;
}

async function commitAll(dir: string, message: string): Promise<void> {
  await run(dir, "add", "-A");
  await run(dir, "commit", "-q", "-m", message);
}

/** Two tracked files and a first commit — the starting point for most cases below. */
async function seededRepo(): Promise<string> {
  const dir = await initRepo();
  await writeFile(join(dir, "kept.txt"), "kept\n");
  await writeFile(join(dir, "edited.txt"), "line1\nline2\n");
  await writeFile(join(dir, "gone.txt"), "gone\n");
  await writeFile(join(dir, "old.txt"), "moved content\nsecond line\n");
  await commitAll(dir, "初始");
  return dir;
}

const byPath = (files: ChangedFile[], path: string): ChangedFile | undefined => files.find((file) => file.path === path);

describe.skipIf(!hasGit)("createGit", () => {
  it("reports nothing for a clean repo", async () => {
    const git = createGit();
    const dir = await seededRepo();
    const snapshot = await git.changes(dir);
    expect(snapshot).toMatchObject({ repoPath: dir, branch: "main", files: [] });
  });

  it("merges staged and unstaged work, and picks up untracked files", async () => {
    const git = createGit();
    const dir = await seededRepo();

    await writeFile(join(dir, "edited.txt"), "line1\nline2\nline3\n");
    await writeFile(join(dir, "added.txt"), "new1\nnew2\n");
    await run(dir, "add", "added.txt");
    await rm(join(dir, "gone.txt"));
    await run(dir, "mv", "old.txt", "renamed.txt");
    await writeFile(join(dir, "loose.txt"), "a\nb\nc\n");

    const { files } = await git.changes(dir);
    expect(files.map((file) => file.path)).toEqual(["added.txt", "edited.txt", "gone.txt", "loose.txt", "renamed.txt"]);

    expect(byPath(files, "edited.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 0, binary: false });
    expect(byPath(files, "added.txt")).toMatchObject({ status: "added", additions: 2, deletions: 0 });
    expect(byPath(files, "gone.txt")).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(byPath(files, "loose.txt")).toMatchObject({ status: "untracked", additions: 3, deletions: 0, binary: false });
    expect(byPath(files, "renamed.txt")).toMatchObject({ status: "renamed", oldPath: "old.txt" });
    expect(byPath(files, "kept.txt")).toBeUndefined();
  });

  it("honours .gitignore", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, ".gitignore"), "ignored/\n");
    await commitAll(dir, "忽略规则");
    await mkdir(join(dir, "ignored"));
    await writeFile(join(dir, "ignored", "secret.txt"), "shh\n");
    await writeFile(join(dir, "visible.txt"), "x\n");
    const { files } = await git.changes(dir);
    expect(files.map((file) => file.path)).toEqual(["visible.txt"]);
  });

  it("flags binary files instead of counting their lines", async () => {
    const git = createGit();
    const dir = await seededRepo();
    const blob = Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]);
    await writeFile(join(dir, "tracked.bin"), blob);
    await commitAll(dir, "二进制");
    await writeFile(join(dir, "loose.bin"), blob);
    await writeFile(join(dir, "tracked.bin"), Buffer.concat([blob, Buffer.from([0x00, 0x09])]));

    const { files } = await git.changes(dir);
    expect(byPath(files, "loose.bin")).toMatchObject({ status: "untracked", binary: true, additions: 0 });
    expect(byPath(files, "tracked.bin")).toMatchObject({ status: "modified", binary: true, additions: 0, deletions: 0 });
    expect(await git.fileDiff(dir, "tracked.bin")).toMatchObject({ binary: true, diff: "", truncated: false });
  });

  it("returns a unified diff for a modified file", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "edited.txt"), "line1\nchanged\n");

    const diff = await git.fileDiff(dir, "edited.txt");
    expect(diff).toMatchObject({ path: "edited.txt", status: "modified", binary: false, truncated: false });
    expect(diff.diff).toContain("@@");
    expect(diff.diff).toContain("+changed");
    expect(diff.diff).toContain("-line2");
  });

  it("diffs an untracked file against /dev/null", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "loose.txt"), "fresh\n");

    const diff = await git.fileDiff(dir, "loose.txt");
    expect(diff.status).toBe("untracked");
    expect(diff.diff).toContain("+fresh");
    expect(diff.truncated).toBe(false);
  });

  it("truncates an oversized diff on a line boundary", async () => {
    const git = createGit({ maxDiffBytes: 200 });
    const dir = await seededRepo();
    await writeFile(join(dir, "edited.txt"), Array.from({ length: 400 }, (_, index) => `行 ${index}`).join("\n") + "\n");

    const diff = await git.fileDiff(dir, "edited.txt");
    expect(diff.truncated).toBe(true);
    expect(Buffer.byteLength(diff.diff)).toBeLessThanOrEqual(200);
    expect(diff.diff.endsWith("\n")).toBe(true);
  });

  it("reverts a modified, a deleted and an untracked file", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "edited.txt"), "毁了\n");
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, "loose.txt"), "临时\n");

    expect(await git.revert(dir, "edited.txt")).toEqual({ path: "edited.txt" });
    expect(await git.revert(dir, "gone.txt")).toEqual({ path: "gone.txt" });
    expect(await git.revert(dir, "loose.txt")).toEqual({ path: "loose.txt" });

    expect(await readFile(join(dir, "edited.txt"), "utf8")).toBe("line1\nline2\n");
    expect(await readFile(join(dir, "gone.txt"), "utf8")).toBe("gone\n");
    expect(await stat(join(dir, "loose.txt")).catch(() => null)).toBeNull();
    expect((await git.changes(dir)).files).toEqual([]);
  });

  it("reverts a staged new file and a rename", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "added.txt"), "new\n");
    await run(dir, "add", "added.txt");
    await run(dir, "mv", "old.txt", "renamed.txt");

    expect(await git.revert(dir, "added.txt")).toEqual({ path: "added.txt" });
    expect(await git.revert(dir, "renamed.txt")).toEqual({ path: "old.txt" });

    expect(await stat(join(dir, "added.txt")).catch(() => null)).toBeNull();
    expect(await stat(join(dir, "renamed.txt")).catch(() => null)).toBeNull();
    expect(await readFile(join(dir, "old.txt"), "utf8")).toBe("moved content\nsecond line\n");
    expect((await git.changes(dir)).files).toEqual([]);
  });

  it("rejects escaping paths and unchanged files", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "edited.txt"), "改了\n");

    await expect(git.fileDiff(dir, "../x")).rejects.toBeInstanceOf(BadRequestError);
    await expect(git.fileDiff(dir, "/abs")).rejects.toBeInstanceOf(BadRequestError);
    await expect(git.fileDiff(dir, "a\\b")).rejects.toBeInstanceOf(BadRequestError);
    await expect(git.fileDiff(dir, "")).rejects.toBeInstanceOf(BadRequestError);
    await expect(git.revert(dir, "../x")).rejects.toBeInstanceOf(BadRequestError);
    // Tracked but untouched: there is nothing to show or undo.
    await expect(git.fileDiff(dir, "kept.txt")).rejects.toBeInstanceOf(NotFoundError);
    await expect(git.revert(dir, "kept.txt")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("works before the first commit", async () => {
    const git = createGit();
    const dir = await initRepo();
    await writeFile(join(dir, "loose.txt"), "a\nb\n");
    await writeFile(join(dir, "staged.txt"), "one\n");
    await run(dir, "add", "staged.txt");

    const snapshot = await git.changes(dir);
    expect(snapshot.branch).toBe("main");
    expect(byPath(snapshot.files, "loose.txt")).toMatchObject({ status: "untracked", additions: 2 });
    expect(byPath(snapshot.files, "staged.txt")).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect((await git.fileDiff(dir, "staged.txt")).diff).toContain("+one");
  });

  it("任务基线是快照时，用户自己的改动一件都不算任务的", async () => {
    const git = createGit();
    const dir = await seededRepo();
    // The user's own work, all of it from before the task started.
    await writeFile(join(dir, "edited.txt"), "line1\nline2\n用户改的\n");
    await writeFile(join(dir, "用户的新文件.txt"), "用户建的\n");
    await writeFile(join(dir, "kept.txt"), "kept\n用户暂存的\n");
    await run(dir, "add", "kept.txt");
    const stagedBefore = (await run(dir, "diff", "--cached", "--name-only")).stdout;

    const baseline = await snapshotTree(dir);

    // What the task did: one tracked file, one new file, and a line appended to
    // the file the user had left untracked.
    await writeFile(join(dir, "gone.txt"), "gone\n任务改的\n");
    await writeFile(join(dir, "任务的新文件.txt"), "任务建的\n");
    await writeFile(join(dir, "用户的新文件.txt"), "用户建的\n任务加的\n");

    const { files } = await git.changes(dir, { tree: baseline });
    expect(files.map((file) => file.path)).toEqual(["gone.txt", "任务的新文件.txt", "用户的新文件.txt"]);
    expect(byPath(files, "gone.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(byPath(files, "任务的新文件.txt")).toMatchObject({ status: "added", additions: 1 });
    // Already untracked when the task started, so it is an edit, not a new file.
    expect(byPath(files, "用户的新文件.txt")).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect((await git.fileDiff(dir, "用户的新文件.txt", { tree: baseline })).diff).toContain("+任务加的");

    // 还原 goes back to the baseline, and the user's index is not part of it.
    expect(await git.revert(dir, "gone.txt", { tree: baseline })).toEqual({ path: "gone.txt" });
    expect(await git.revert(dir, "任务的新文件.txt", { tree: baseline })).toEqual({ path: "任务的新文件.txt" });
    expect(await readFile(join(dir, "gone.txt"), "utf8")).toBe("gone\n");
    expect(await stat(join(dir, "任务的新文件.txt")).catch(() => null)).toBeNull();
    expect((await run(dir, "diff", "--cached", "--name-only")).stdout).toBe(stagedBefore);
    expect(await readFile(join(dir, "edited.txt"), "utf8")).toBe("line1\nline2\n用户改的\n");
  });

  it("还没有基线的任务什么都没改", async () => {
    const git = createGit();
    const dir = await seededRepo();
    await writeFile(join(dir, "edited.txt"), "line1\nline2\n用户改的\n");
    await writeFile(join(dir, "用户的新文件.txt"), "用户建的\n");

    const snapshot = await git.changes(dir, { none: true });
    expect(snapshot).toMatchObject({ branch: "main", files: [] });
    await expect(git.fileDiff(dir, "edited.txt", { none: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(git.revert(dir, "edited.txt", { none: true })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a directory that is not a repo", async () => {
    const git = createGit();
    await expect(git.changes(await tempDir())).rejects.toBeInstanceOf(NotAGitRepoError);
    await expect(git.changes(join(await tempDir(), "missing"))).rejects.toBeInstanceOf(NotAGitRepoError);
  });
});
