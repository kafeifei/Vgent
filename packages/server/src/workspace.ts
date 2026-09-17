/**
 * Per-task git worktrees.
 *
 * A thread can run in `<dataDir>/worktrees/<threadId>` instead of the project's
 * own working tree, so its edits never touch what the user has open. The
 * directory holds real user work — including files git ignores — so the only
 * destructive step (`git worktree remove`) is fenced in:
 *
 *   - an ownership file written *before* the directory exists, so a crash
 *     leaves an inspectable orphan rather than an unowned deletion candidate;
 *   - seven ownership checks re-run immediately before every removal;
 *   - a snapshot that hashes the tree before and after copying, and that saves
 *     the index's blobs explicitly (they become unreachable once the worktree
 *     is gone, and git gc would take them).
 *
 * Ported from `../freecode/server/workspace.ts`, trimmed to what the server
 * actually calls and re-typed onto this package's errors and stores.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BadRequestError, ConflictError, GitError, GitUnavailableError, NotFoundError } from "./errors.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
import type { Project, ThreadRecord, ThreadWorkspace } from "./types.js";

/** Where the anchor ref for a task lives — it keeps the base commit reachable. */
const anchorRef = (threadId: string) => `refs/vgent/tasks/${threadId}`;

const MAX_BUFFER = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/** What `<dataDir>/workspaces/<threadId>.json` records about a worktree. */
export interface WorkspaceOwnership {
  threadId: string;
  workspacePath: string;
  projectPath: string;
  commonDir: string;
  branch: string;
}

interface SnapshotManifest {
  version: 1;
  threadId: string;
  head: string;
  branch: string;
  createdAt: string;
  /** Every blob object the index referenced, saved under `objects/`. */
  indexObjects: string[];
}

interface ExecError extends Error {
  code?: number | string;
  stderr?: string | Buffer;
  killed?: boolean;
}

function gitFailure(args: readonly string[], error: ExecError): Error {
  if (error.code === "ENOENT") return new GitUnavailableError();
  const stderr = (typeof error.stderr === "string" ? error.stderr : error.stderr?.toString("utf8")) ?? "";
  return new GitError(`git ${args.join(" ")} 失败: ${stderr.trim().slice(0, 500) || error.message}`);
}

/** Every git call here: no shell, no pager, no prompt, no quoted paths. */
function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const full = ["-c", "core.quotepath=false", ...args];
  return new Promise((done, fail) => {
    execFile(
      "git",
      full,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...env },
      },
      (error, stdout) => (error == null ? done(stdout) : fail(gitFailure(full, error as ExecError))),
    );
  });
}

/** `git cat-file blob`, which must not go through a utf8 decode. */
function gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => (error == null ? done(stdout) : fail(gitFailure(args, error as ExecError))),
    );
  });
}

async function exists(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// --- serialization ------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
/**
 * Per-key serialization. Process-wide on purpose: two `createApp`s pointing at
 * one dataDir must not reclaim the same directory at once.
 */
export async function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  locks.set(
    key,
    current.catch(() => {}),
  );
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

const busy = new Set<string>();
/** Refuses re-entry instead of queueing: the caller is a user action, not a retry loop. */
export async function workspaceOperation<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(workspacePath);
  if (busy.has(key)) throw new ConflictError("工作目录正在归档或恢复，请稍后重试", "workspace_busy");
  busy.add(key);
  try {
    return await operation();
  } finally {
    busy.delete(key);
  }
}

// --- paths --------------------------------------------------------------

const ownerPath = (dataDir: string, threadId: string) => join(dataDir, "workspaces", `${threadId}.json`);
const snapshotsDir = (dataDir: string, threadId: string) => join(dataDir, "snapshots", threadId);

/**
 * `<dataDir>/worktrees/<threadId>` with the parent fully resolved, so
 * `verifyOwnership`'s "the parent is its own realpath" check holds on machines
 * where the data dir itself sits behind a symlink (`/var` → `/private/var`).
 */
async function expectedPath(dataDir: string, threadId: string): Promise<string> {
  const root = join(dataDir, "worktrees");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return join(await realpath(root), threadId);
}

async function commonDirOf(cwd: string): Promise<string> {
  return realpath(resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim()));
}

async function indexPath(cwd: string): Promise<string> {
  return resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "index"])).trim());
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  } catch {
    return (await git(cwd, ["rev-parse", "HEAD"])).trim();
  }
}

/** `git worktree list` records, as `worktree <path>` / `branch refs/heads/<name>` lines. */
async function worktreeEntries(repoPath: string): Promise<string[]> {
  const output = await git(repoPath, ["worktree", "list", "--porcelain", "-z"]).catch(() => "");
  return output.split("\0");
}

// --- create -------------------------------------------------------------

export interface CreateWorktreeOptions {
  dataDir: string;
  project: Project;
  threadId: string;
}

/**
 * A fresh worktree on a new `vgent/<id8>` branch at the project's HEAD. The
 * project's own checkout is never touched — `git worktree add` does not switch
 * branches in it.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<ThreadWorkspace> {
  const { dataDir, project, threadId } = options;
  const workspacePath = await expectedPath(dataDir, threadId);
  const branch = `vgent/${threadId.slice(0, 8)}`;

  let baseCommit: string;
  try {
    baseCommit = (await git(project.repoPath, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
  } catch {
    throw new BadRequestError("仓库还没有任何提交，无法创建独立 worktree。请先提交一次，或使用主工作区。", "repo_has_no_commits");
  }

  if (await exists(workspacePath)) throw new ConflictError("工作目录已存在，未覆盖任何文件", "workspace_exists");
  const commonDir = await commonDirOf(project.repoPath);

  // Ownership first: a crash between here and `worktree add` leaves a record
  // pointing at nothing, which is inspectable. The reverse leaves a directory
  // nothing claims, which we would then refuse to remove.
  await mkdir(dirname(ownerPath(dataDir, threadId)), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(
    ownerPath(dataDir, threadId),
    { threadId, workspacePath, projectPath: project.repoPath, commonDir, branch } satisfies WorkspaceOwnership,
    { mode: 0o600 },
  );
  await git(project.repoPath, ["worktree", "add", "-b", branch, "--", workspacePath, baseCommit]);
  // The anchor keeps the base commit reachable even if the branch moves on.
  await git(project.repoPath, ["update-ref", anchorRef(threadId), baseCommit]);

  return { mode: "worktree", path: workspacePath, branch, baseCommit };
}

// --- ownership ----------------------------------------------------------

export interface VerifyOwnershipOptions {
  dataDir: string;
  project: Project;
  thread: Pick<ThreadRecord, "id" | "workspace">;
  /** For restore, where the directory is supposed to be gone. */
  allowMissing?: boolean;
}

/**
 * Seven checks between a thread and a directory on disk. Everything that
 * deletes files calls this immediately before it does, and a failure means the
 * caller leaves the directory exactly as it found it.
 */
export async function verifyOwnership(options: VerifyOwnershipOptions): Promise<WorkspaceOwnership> {
  const { dataDir, project, thread } = options;
  const workspace = thread.workspace;
  const expected = await expectedPath(dataDir, thread.id);
  if (workspace?.mode !== "worktree" || workspace.path !== expected) {
    throw new ConflictError("工作目录不属于此任务，未执行任何删除", "workspace_not_owned");
  }

  const raw = await readFile(ownerPath(dataDir, thread.id), "utf8").catch(() => undefined);
  if (raw == null) throw new ConflictError("找不到工作目录的所有权记录，未执行任何删除", "workspace_owner_missing");
  let owner: WorkspaceOwnership;
  try {
    owner = JSON.parse(raw) as WorkspaceOwnership;
  } catch {
    throw new ConflictError("工作目录的所有权记录已损坏，未执行任何删除", "workspace_owner_corrupt");
  }
  if (owner.threadId !== thread.id || owner.workspacePath !== workspace.path || owner.projectPath !== project.repoPath) {
    throw new ConflictError("工作目录所有权记录不匹配，未执行任何删除", "workspace_owner_mismatch");
  }

  const parent = dirname(workspace.path);
  if ((await realpath(parent).catch(() => undefined)) !== parent) {
    throw new ConflictError("工作目录父路径已更改，未执行任何删除", "workspace_parent_changed");
  }

  if (!(await exists(workspace.path))) {
    if (options.allowMissing === true) return owner;
    throw new ConflictError("工作目录不存在", "workspace_missing");
  }
  if ((await lstat(workspace.path)).isSymbolicLink()) {
    throw new ConflictError("工作目录变成了符号链接，未执行任何删除", "workspace_is_symlink");
  }
  if (!(await stat(workspace.path)).isDirectory()) {
    throw new ConflictError("工作目录不是目录，未执行任何删除", "workspace_not_a_dir");
  }
  if ((await commonDirOf(workspace.path)) !== owner.commonDir) {
    throw new ConflictError("工作目录的 Git 仓库已更改，未执行任何删除", "workspace_repo_changed");
  }
  if (!(await worktreeEntries(owner.projectPath)).includes(`worktree ${workspace.path}`)) {
    throw new ConflictError("Git 已不再管理此工作目录，未执行任何删除", "workspace_not_registered");
  }
  return owner;
}

// --- snapshot -----------------------------------------------------------

/**
 * A sha256 over every entry's path, mode, type, link target and bytes — the
 * whole tree including ignored files, `.git` excluded. Two directories with
 * the same digest hold the same user work.
 */
export async function inventory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(relative: string): Promise<void> {
    for (const entry of (await readdir(join(root, relative))).sort()) {
      if (relative === "" && entry === ".git") continue;
      const name = join(relative, entry);
      const location = join(root, name);
      const info = await lstat(location);
      hash.update(JSON.stringify([name, info.mode & 0o777, info.isDirectory() ? "dir" : info.isSymbolicLink() ? "link" : "file"]));
      if (info.isSymbolicLink()) hash.update(await readlink(location));
      else if (info.isDirectory()) await walk(name);
      else if (info.isFile()) {
        for await (const chunk of createReadStream(location)) hash.update(chunk as Buffer);
      } else throw new ConflictError(`目录包含不能安全归档的特殊文件：${name}。文件未回收。`, "workspace_special_file");
    }
  }
  await walk("");
  return hash.digest("hex");
}

async function copyContents(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source)) {
    if (entry === ".git") continue;
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
}

export interface MakeSnapshotOptions {
  dataDir: string;
  project: Project;
  thread: Pick<ThreadRecord, "id" | "workspace">;
  /** Test seam: runs between the first inventory and the copy. */
  onBeforeCopy?: () => Promise<void> | void;
}

/**
 * Everything the worktree holds, copied to `<dataDir>/snapshots/<id>/<uuid>/`:
 * the files (ignored ones included), the index, and every blob the index
 * points at. If anything in the directory moved while we were copying, the
 * snapshot is abandoned and the worktree is left alone.
 */
export async function makeSnapshot(options: MakeSnapshotOptions): Promise<string> {
  const { dataDir, thread } = options;
  const workspacePath = thread.workspace?.path;
  if (workspacePath == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");

  const destination = join(snapshotsDir(dataDir, thread.id), randomUUID());
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const head = (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
  const branch = await currentBranch(workspacePath);
  const sourceIndex = await indexPath(workspacePath);
  const indexBefore = await readFile(sourceIndex);
  const before = await inventory(workspacePath);

  await options.onBeforeCopy?.();
  await copyContents(workspacePath, join(destination, "files"));

  // A split index is a pointer into the shared one, which dies with the
  // worktree; normalize it into a standalone file before saving it.
  const indexTemporary = `${sourceIndex}.vgent-${randomUUID()}`;
  try {
    await writeFile(indexTemporary, indexBefore, { flag: "wx", mode: 0o600 });
    await git(workspacePath, ["update-index", "--no-split-index"], { GIT_INDEX_FILE: indexTemporary });
    await cp(indexTemporary, join(destination, "index"));
  } finally {
    await rm(indexTemporary, { force: true });
  }

  // Index blobs become unreachable once the worktree is gone, so git gc is
  // free to take them. Save them by hand.
  const indexObjects = [
    ...new Set(
      (await git(workspacePath, ["ls-files", "--stage", "-z"]))
        .split("\0")
        .filter((line) => line.length > 0)
        .map((line) => line.split(" ")[1] ?? ""),
    ),
  ].filter((object) => object.length > 0 && !/^0+$/.test(object));
  await mkdir(join(destination, "objects"), { recursive: true, mode: 0o700 });
  for (const object of indexObjects) {
    const type = (await git(workspacePath, ["cat-file", "-t", object])).trim();
    if (type !== "blob") {
      throw new ConflictError("此任务包含 Git 子模块，暂不回收其工作目录；所有文件仍保留。", "workspace_has_gitlink");
    }
    await writeFile(join(destination, "objects", object), await gitBuffer(workspacePath, ["cat-file", "blob", object]));
  }

  if (
    before !== (await inventory(join(destination, "files"))) ||
    before !== (await inventory(workspacePath)) ||
    !indexBefore.equals(await readFile(sourceIndex)) ||
    head !== (await git(workspacePath, ["rev-parse", "HEAD"])).trim()
  ) {
    throw new ConflictError("归档期间文件发生了变化，已保留工作目录。请停止外部编辑后重试。", "workspace_changed_during_snapshot");
  }

  await writeJsonAtomic(join(destination, "manifest.json"), {
    version: 1,
    threadId: thread.id,
    head,
    branch,
    createdAt: new Date().toISOString(),
    indexObjects,
  } satisfies SnapshotManifest);
  await git(workspacePath, ["update-ref", anchorRef(thread.id), head]);
  return destination;
}

// --- reclaim / restore --------------------------------------------------

export interface WorkspaceTaskOptions {
  dataDir: string;
  project: Project;
  thread: Pick<ThreadRecord, "id" | "workspace">;
}

/**
 * Snapshot the worktree, then remove it. The branch and the anchor ref stay:
 * this gives the disk space back, it does not throw history away.
 */
export async function reclaimWorktree(options: WorkspaceTaskOptions & { onBeforeCopy?: () => Promise<void> | void }): Promise<{ snapshotPath: string }> {
  const { dataDir, project, thread } = options;
  const workspacePath = thread.workspace?.path;
  if (workspacePath == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");

  return locked(`workspace:${thread.id}`, () =>
    workspaceOperation(workspacePath, async () => {
      const owner = await verifyOwnership({ dataDir, project, thread });
      const snapshotPath = await makeSnapshot({
        dataDir,
        project,
        thread,
        ...(options.onBeforeCopy != null ? { onBeforeCopy: options.onBeforeCopy } : {}),
      });
      // Re-checked immediately before the only destructive call.
      await verifyOwnership({ dataDir, project, thread });
      await git(owner.projectPath, ["worktree", "remove", "--force", "--", workspacePath]);
      await git(owner.projectPath, ["worktree", "prune"]).catch(() => "");
      return { snapshotPath };
    }),
  );
}

/**
 * Put a reclaimed worktree back, byte for byte: the same files, the same
 * index, the same staged blobs. The original branch is reused only if nothing
 * touched it since; otherwise the restore mints its own.
 */
export async function restoreWorktree(options: WorkspaceTaskOptions & { snapshotPath: string }): Promise<{ branch: string }> {
  const { dataDir, project, thread, snapshotPath } = options;
  const workspacePath = thread.workspace?.path;
  if (workspacePath == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");

  return locked(`workspace:${thread.id}`, () =>
    workspaceOperation(workspacePath, async () => {
      const owner = await verifyOwnership({ dataDir, project, thread, allowMissing: true });
      if (await exists(workspacePath)) throw new ConflictError("恢复位置已有文件，未覆盖。请先处理该目录。", "workspace_occupied");

      const raw = await readFile(join(snapshotPath, "manifest.json"), "utf8").catch(() => undefined);
      if (raw == null) throw new NotFoundError("找不到归档快照", "snapshot_not_found");
      const manifest = JSON.parse(raw) as SnapshotManifest;
      if (manifest.version !== 1 || manifest.threadId !== thread.id || dirname(dirname(snapshotPath)) !== join(dataDir, "snapshots")) {
        throw new ConflictError("归档快照不属于此任务", "snapshot_not_owned");
      }
      await git(owner.projectPath, ["cat-file", "-e", `${manifest.head}^{commit}`]);

      let branch = manifest.branch;
      let branchHead = "";
      try {
        branchHead = (await git(owner.projectPath, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
      } catch {
        // Deleted branch, or the snapshot was taken on a detached HEAD.
      }
      const branchIsFree = !(await worktreeEntries(owner.projectPath)).includes(`branch refs/heads/${branch}`);
      // Never rewind or seize a branch somebody used after the reclaim.
      if (branchHead !== manifest.head || !branchIsFree) branch = `vgent/${thread.id.slice(0, 8)}-restored-${randomUUID().slice(0, 8)}`;

      const reuse = branch === manifest.branch;
      await git(owner.projectPath, ["worktree", "add", ...(reuse ? [] : ["-b", branch]), "--", workspacePath, reuse ? branch : manifest.head]);

      // A mid-restore failure leaves the partial directory and the snapshot in
      // place: the directory may already carry an external edit, and the
      // snapshot is the only copy of the rest.
      await verifyOwnership({ dataDir, project, thread });
      for (const entry of await readdir(workspacePath)) {
        if (entry !== ".git") await rm(join(workspacePath, entry), { recursive: true, force: true });
      }
      await copyContents(join(snapshotPath, "files"), workspacePath);
      for (const object of manifest.indexObjects) {
        const actual = (await git(workspacePath, ["hash-object", "-w", "--", join(snapshotPath, "objects", object)])).trim();
        if (actual !== object) throw new ConflictError("归档中的 Git 暂存文件校验失败", "snapshot_blob_mismatch");
      }
      await cp(join(snapshotPath, "index"), await indexPath(workspacePath));
      if ((await inventory(workspacePath)) !== (await inventory(join(snapshotPath, "files")))) {
        throw new ConflictError("恢复文件校验失败，快照仍完整保留", "restore_verify_failed");
      }
      await writeJsonAtomic(ownerPath(dataDir, thread.id), { ...owner, branch } satisfies WorkspaceOwnership, { mode: 0o600 });
      return { branch };
    }),
  );
}

// --- delete -------------------------------------------------------------

/**
 * Everything this task created, gone: the worktree, the anchor ref, the
 * ownership file and the snapshots. The `vgent/<id8>` branch survives unless
 * it is still exactly the commit the task started from — a branch with commits
 * on it is history, and history is never deleted here.
 */
export async function removeWorktree(options: WorkspaceTaskOptions): Promise<{ removedWorktree: boolean; removedBranch: boolean }> {
  const { dataDir, project, thread } = options;
  const workspace = thread.workspace;
  if (workspace == null) return { removedWorktree: false, removedBranch: false };

  return locked(`workspace:${thread.id}`, () =>
    workspaceOperation(workspace.path, async () => {
      const result = { removedWorktree: false, removedBranch: false };
      // A reclaimed task has no directory left to check or remove, and its
      // branch is the only place its work still exists: leave it alone.
      if (workspace.reclaimed !== true) {
        if (await exists(workspace.path)) {
          await verifyOwnership({ dataDir, project, thread });
          await git(project.repoPath, ["worktree", "remove", "--force", "--", workspace.path]);
          result.removedWorktree = true;
        }
        await git(project.repoPath, ["worktree", "prune"]).catch(() => "");

        const stillCheckedOut = (await worktreeEntries(project.repoPath)).includes(`branch refs/heads/${workspace.branch}`);
        let tip = "";
        try {
          tip = (await git(project.repoPath, ["rev-parse", "--verify", `refs/heads/${workspace.branch}`])).trim();
        } catch {
          // Already gone.
        }
        if (!stillCheckedOut && tip === workspace.baseCommit && workspace.branch.startsWith("vgent/")) {
          result.removedBranch = await git(project.repoPath, ["branch", "-D", "--", workspace.branch]).then(
            () => true,
            () => false,
          );
        }
      }
      await git(project.repoPath, ["update-ref", "-d", anchorRef(thread.id)]).catch(() => "");
      await rm(snapshotsDir(dataDir, thread.id), { recursive: true, force: true });
      await rm(ownerPath(dataDir, thread.id), { force: true });
      return result;
    }),
  );
}
