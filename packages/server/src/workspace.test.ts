import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Project, ThreadRecord, ThreadWorkspace } from "./types.js";
import { countUncommitted, createWorktree, inventory, reclaimWorktree, removeWorktree, restoreWorktree, verifyOwnership } from "./workspace.js";

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

// Real git all the way down: a reclaim-and-restore round trip is ~100 git
// processes in a row, which a loaded full-suite run stretches past vitest's 5s.
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
    // Staged, then edited again: the index and the file on disk disagree.
    await writeFile(join(workspace.path, "staged.txt"), "暂存之后又改了\n");
    const before = await inventory(workspace.path);

    expect(await countUncommitted(workspace.path)).toBe(3);
    const { snapshotPath } = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace), preserveChanges: true });
    // The changes live in git now, not in a copy of the directory.
    const archive = (await run(repo, "rev-parse", `refs/vgent/archive/${id}`)).stdout.trim();
    expect(JSON.parse(await readFile(join(snapshotPath, "manifest.json"), "utf8"))).toMatchObject({ version: 2, archive, branch: workspace.branch });
    await expect(readFile(join(workspace.path, "untracked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).not.toContain(workspace.path);

    const reclaimed: ThreadWorkspace = { ...workspace, reclaimed: true, snapshotPath };
    const { branch } = await restoreWorktree({ dataDir, project, thread: threadOf(id, reclaimed), snapshotPath });

    expect(branch).toBe(workspace.branch);
    expect(await inventory(workspace.path)).toBe(before);
    expect(await readFile(join(workspace.path, "untracked.txt"), "utf8")).toBe("只在工作目录里\n");
    expect(await readFile(join(workspace.path, "tracked.txt"), "utf8")).toBe("line1\n改了\n");
    // The index came back too, so the staged file is still staged — as it was staged.
    expect((await run(workspace.path, "diff", "--cached", "--name-only")).stdout.trim()).toBe("staged.txt");
    expect((await run(workspace.path, "show", ":staged.txt")).stdout).toBe("暂存但未提交\n");
    expect(await readFile(join(workspace.path, "staged.txt"), "utf8")).toBe("暂存之后又改了\n");
    // Consumed once the changes are back.
    await expect(run(repo, "rev-parse", "--verify", `refs/vgent/archive/${id}`)).rejects.toBeDefined();
    expect(await status(repo)).toBe("");
  });

  it("takes uncommitted changes only when told to, and touches nothing otherwise", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "confirm0-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await writeFile(join(workspace.path, "tracked.txt"), "line1\n改了\n");
    await run(workspace.path, "mv", "tracked.txt", "renamed.txt");
    // A rename is one file, not its two paths.
    expect(await countUncommitted(workspace.path)).toBe(1);

    await expect(reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace) })).rejects.toMatchObject({ code: "archive_needs_confirmation" });
    expect(await readFile(join(workspace.path, "renamed.txt"), "utf8")).toBe("line1\n改了\n");
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).toContain(workspace.path);
    await expect(run(repo, "rev-parse", "--verify", `refs/vgent/archive/${id}`)).rejects.toBeDefined();
  });

  it("leaves ignored files behind and keeps no archive for a clean worktree", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    await writeFile(join(repo, ".gitignore"), "node_modules/\n*.log\n");
    await run(repo, "add", ".gitignore");
    await run(repo, "commit", "-q", "-m", "忽略");
    const id = "ignored0-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await mkdir(join(workspace.path, "node_modules", "dep"), { recursive: true });
    await writeFile(join(workspace.path, "node_modules", "dep", "index.js"), "装出来的\n");
    await writeFile(join(workspace.path, "debug.log"), "日志\n");

    const { snapshotPath } = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace) });
    expect(JSON.parse(await readFile(join(snapshotPath, "manifest.json"), "utf8"))).not.toHaveProperty("archive");
    await expect(run(repo, "rev-parse", "--verify", `refs/vgent/archive/${id}`)).rejects.toBeDefined();

    await restoreWorktree({ dataDir, project, thread: threadOf(id, { ...workspace, reclaimed: true, snapshotPath }), snapshotPath });
    // Rebuilding them is the setup's job, not the archive's.
    await expect(readFile(join(workspace.path, "debug.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(workspace.path, "node_modules", "dep", "index.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await status(workspace.path)).toBe("");
  });

  it("keeps the worktree and no archive when a file changes mid-archive", async () => {
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
        preserveChanges: true,
        onCaptured: () => writeFile(join(workspace.path, "busy.txt"), "外部编辑\n"),
      }),
    ).rejects.toMatchObject({ code: "workspace_changed_during_snapshot" });

    expect(await readFile(join(workspace.path, "busy.txt"), "utf8")).toBe("外部编辑\n");
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).toContain(workspace.path);
    await expect(run(repo, "rev-parse", "--verify", `refs/vgent/archive/${id}`)).rejects.toBeDefined();
  });

  it("finishes a reclaim whose directory went before the record said so", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "resumerc-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await writeFile(join(workspace.path, "work.txt"), "没提交\n");

    const first = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace), preserveChanges: true });
    // The process died before recording the reclaim: the record still points at a live directory.
    const again = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace), preserveChanges: true });
    expect(again.snapshotPath).toBe(first.snapshotPath);
  });

  it("takes a failed restore back so the next one starts clean", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "rollback-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await writeFile(join(workspace.path, "work.txt"), "没提交\n");
    const { snapshotPath } = await reclaimWorktree({ dataDir, project, thread: threadOf(id, workspace), preserveChanges: true });
    const reclaimed = threadOf(id, { ...workspace, reclaimed: true, snapshotPath });

    const ref = `refs/vgent/archive/${id}`;
    const archive = (await run(repo, "rev-parse", ref)).stdout.trim();
    await run(repo, "update-ref", ref, workspace.baseCommit);
    await expect(restoreWorktree({ dataDir, project, thread: reclaimed, snapshotPath })).rejects.toMatchObject({ code: "archive_mismatch" });
    expect((await run(repo, "worktree", "list", "--porcelain")).stdout).not.toContain(workspace.path);

    await run(repo, "update-ref", ref, archive);
    await restoreWorktree({ dataDir, project, thread: reclaimed, snapshotPath });
    expect(await readFile(join(workspace.path, "work.txt"), "utf8")).toBe("没提交\n");
  });

  it("still restores a snapshot copied byte for byte by an older version", async () => {
    const dataDir = await tempDir("vgent-ws-data-");
    const repo = await seededRepo();
    const id = "legacyv1-0000-0000-0000-000000000001";
    const project = projectOf(repo);
    const workspace = await createWorktree({ dataDir, project, threadId: id });
    await writeFile(join(workspace.path, "old.txt"), "旧版快照里的\n");

    const snapshotPath = join(dataDir, "snapshots", id, "legacy");
    await cp(workspace.path, join(snapshotPath, "files"), { recursive: true, filter: (source) => !source.endsWith("/.git") });
    const index = (await run(workspace.path, "rev-parse", "--git-path", "index")).stdout.trim();
    await cp(resolve(workspace.path, index), join(snapshotPath, "index"));
    await writeFile(
      join(snapshotPath, "manifest.json"),
      JSON.stringify({ version: 1, threadId: id, head: workspace.baseCommit, branch: workspace.branch, createdAt: new Date().toISOString(), indexObjects: [] }),
    );
    await run(repo, "worktree", "remove", "--force", workspace.path);

    await restoreWorktree({ dataDir, project, thread: threadOf(id, { ...workspace, reclaimed: true, snapshotPath }), snapshotPath });
    expect(await readFile(join(workspace.path, "old.txt"), "utf8")).toBe("旧版快照里的\n");
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
}, 30_000);
