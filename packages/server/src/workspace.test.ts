import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ThreadRecord, ThreadWorkspace } from "./types.js";
import { createWorktree, inventory, reclaimWorktree, removeWorktree, restoreWorktree, verifyOwnership } from "./workspace.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const run = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** A repo with one commit and its own git identity. */
async function seededRepo(): Promise<string> {
  const dir = await tempDir("vgent-ws-repo-");
  await run(dir, "init", "-q", "-b", "main");
  await run(dir, "config", "user.email", "test@vgent.local");
  await run(dir, "config", "user.name", "Vgent Test");
  await run(dir, "config", "commit.gpgsign", "false");
  await writeFile(join(dir, "tracked.txt"), "line1\nline2\n");
  await run(dir, "add", "-A");
  await run(dir, "commit", "-q", "-m", "初始");
  return dir;
}

const projectOf = (repoPath: string): Project => ({
  id: "p1",
  name: "repo",
  repoPath,
  createdAt: new Date().toISOString(),
});

const threadOf = (id: string, workspace: ThreadWorkspace): Pick<ThreadRecord, "id" | "workspace"> => ({ id, workspace });

const status = async (repoPath: string): Promise<string> => (await run(repoPath, "status", "--porcelain")).stdout;

describe.skipIf(!hasGit)("workspace", () => {
  it("creates a worktree whose edits never reach the project's working tree", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const workspace = await createWorktree({ dataDir, project: projectOf(repo), threadId: "1234abcd-0000-0000-0000-000000000001" });

    expect(workspace.mode).toBe("worktree");
    expect(workspace.branch).toBe("vgent/1234abcd");
    expect((await run(workspace.path, "branch", "--show-current")).stdout.trim()).toBe("vgent/1234abcd");
    expect(workspace.baseCommit).toBe((await run(repo, "rev-parse", "HEAD")).stdout.trim());
    // The anchor ref pins the base commit even if the branch moves on.
    expect((await run(repo, "rev-parse", "refs/vgent/tasks/1234abcd-0000-0000-0000-000000000001")).stdout.trim()).toBe(workspace.baseCommit);

    await writeFile(join(workspace.path, "only-here.txt"), "worktree\n");
    await writeFile(join(workspace.path, "tracked.txt"), "line1\n改了\n");

    expect(await status(repo)).toBe("");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("refuses a repo with no commits", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await tempDir("vgent-ws-repo-");
    await run(repo, "init", "-q", "-b", "main");
    await expect(createWorktree({ dataDir, project: projectOf(repo), threadId: "empty000-0000-0000-0000-000000000001" })).rejects.toMatchObject({
      code: "repo_has_no_commits",
      status: 400,
    });
  });

  it("rejects a tampered ownership record and a directory swapped for a symlink", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "tamper00-0000-0000-0000-000000000001";
    const workspace = await createWorktree({ dataDir, project: projectOf(repo), threadId: id });
    const thread = threadOf(id, workspace);

    await expect(verifyOwnership({ dataDir, project: projectOf(repo), thread })).resolves.toMatchObject({ threadId: id });

    // A record pointing at another project must never authorize a deletion.
    const owner = join(dataDir, "workspaces", `${id}.json`);
    const saved = await readFile(owner, "utf8");
    await writeFile(owner, JSON.stringify({ ...(JSON.parse(saved) as object), projectPath: "/tmp/somewhere-else" }));
    await expect(verifyOwnership({ dataDir, project: projectOf(repo), thread })).rejects.toMatchObject({ code: "workspace_owner_mismatch" });
    await writeFile(owner, saved);

    const elsewhere = await tempDir("vgent-ws-decoy-");
    await rm(workspace.path, { recursive: true, force: true });
    await symlink(elsewhere, workspace.path);
    await expect(verifyOwnership({ dataDir, project: projectOf(repo), thread })).rejects.toMatchObject({ code: "workspace_is_symlink" });
    await rm(workspace.path, { force: true });
  });

  it("round-trips untracked, modified and staged work through reclaim and restore", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "roundtri-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });

    await writeFile(join(workspace.path, "untracked.txt"), "只在工作目录里\n");
    await writeFile(join(workspace.path, "tracked.txt"), "line1\n改了\n");
    await writeFile(join(workspace.path, "staged.txt"), "暂存但未提交\n");
    await run(workspace.path, "add", "staged.txt");
    const before = await inventory(workspace.path);
    const stagedBlob = (await run(workspace.path, "rev-parse", ":staged.txt")).stdout.trim();

    const { snapshotPath } = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace) });
    expect(await readFile(join(snapshotPath, "objects", stagedBlob), "utf8")).toBe("暂存但未提交\n");
    await expect(readFile(join(workspace.path, "untracked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).not.toContain(workspace.path);

    const reclaimed: ThreadWorkspace = { ...workspace, reclaimed: true, snapshotPath };
    const { branch } = await restoreWorktree({ dataDir, project, thread: threadOf(id, reclaimed), snapshotPath });

    expect(branch).toBe(workspace.branch);
    expect(await inventory(workspace.path)).toBe(before);
    expect(await readFile(join(workspace.path, "untracked.txt"), "utf8")).toBe("只在工作目录里\n");
    expect(await readFile(join(workspace.path, "tracked.txt"), "utf8")).toBe("line1\n改了\n");
    // The index came back too, so the staged file is still staged.
    expect((await run(workspace.path, "diff", "--cached", "--name-only")).stdout.trim()).toBe("staged.txt");
    expect(await status(repo)).toBe("");
  });

  it("abandons the snapshot and keeps the worktree when a file changes mid-copy", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "racecond-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await writeFile(join(workspace.path, "busy.txt"), "第一版\n");

    await expect(
      reclaimWorktree({
        dataDir,
        project,
        thread: threadOf(id, workspace),
        onBeforeCopy: () => writeFile(join(workspace.path, "busy.txt"), "外部编辑\n"),
      }),
    ).rejects.toMatchObject({ code: "workspace_changed_during_snapshot" });

    expect(await readFile(join(workspace.path, "busy.txt"), "utf8")).toBe("外部编辑\n");
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).toContain(workspace.path);
  });

  it("deletes the task branch only when the task committed nothing", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const project = projectOf(repo);

    const untouchedId = "cleanjob-0000-0000-0000-000000000001";
    const untouched = await createWorktree({ dataDir, project, threadId: untouchedId });
    await writeFile(join(untouched.path, "scratch.txt"), "没提交\n");
    expect(await removeWorktree({ dataDir, project, thread: threadOf(untouchedId, untouched) })).toEqual({
      removedWorktree: true,
      removedBranch: true,
    });
    expect((await run(repo, "branch", "--list", untouched.branch)).stdout.trim()).toBe("");

    const committedId = "workdone-0000-0000-0000-000000000001";
    const committed = await createWorktree({ dataDir, project, threadId: committedId });
    await writeFile(join(committed.path, "feature.txt"), "做完了\n");
    await run(committed.path, "add", "-A");
    await run(committed.path, "commit", "-q", "-m", "任务的提交");
    expect(await removeWorktree({ dataDir, project, thread: threadOf(committedId, committed) })).toEqual({
      removedWorktree: true,
      removedBranch: false,
    });
    expect((await run(repo, "branch", "--list", committed.branch)).stdout).toContain(committed.branch);
    // The ownership file and the anchor ref go either way.
    await expect(readFile(join(dataDir, "workspaces", `${committedId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
