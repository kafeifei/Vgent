/**
 * Per-task git worktrees.
 *
 * A thread can run in `<dataDir>/worktrees/<threadId>` instead of the project's
 * own working tree, so its edits never touch what the user has open. The only
 * destructive step (`git worktree remove`) is fenced in:
 *
 *   - an ownership file written *before* the directory exists, so a crash
 *     leaves an inspectable orphan rather than an unowned deletion candidate;
 *   - seven ownership checks re-run immediately before every removal;
 *   - 归档 keeps what git can see — the index, the tracked edits, the untracked
 *     files that are not ignored — as a stash-shaped commit under a private
 *     ref, and removes the directory only once a second capture proves nothing
 *     moved in between.
 *
 * Ignored files (`node_modules`, build output, a local `.env`) are not
 * archived. The project's `worktrees.json` brings them back, on creation and
 * on restore alike: `include-files` are copied from the project checkout, the
 * rest is rebuilt by its setup. This is Fumie's worktree contract.
 *
 * Ported from `../freecode/server/workspace.ts`; 归档 / 取消归档 follow
 * Fumie's `WorktreeIsolation` (`~/Codes/fumie`).
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BadRequestError, ConflictError, GitError, GitUnavailableError, NotFoundError } from "./errors.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
import type { Project, ThreadRecord, ThreadWorkspace } from "./types.js";

/** Where the anchor ref for a task lives — it keeps the base commit reachable. */
const anchorRef = (threadId: string) => `refs/vgent/tasks/${threadId}`;
/** Where 归档 keeps a task's uncommitted work, when it has any. */
const archiveRef = (threadId: string) => `refs/vgent/archive/${threadId}`;

/** Author of the archive's own commits, so a repo with no `user.name` can archive too. */
const ARCHIVE_IDENTITY = {
  GIT_AUTHOR_NAME: "Vgent",
  GIT_AUTHOR_EMAIL: "vgent@localhost",
  GIT_COMMITTER_NAME: "Vgent",
  GIT_COMMITTER_EMAIL: "vgent@localhost",
};

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

/**
 * What 归档 writes to `<dataDir>/snapshots/<id>/<uuid>/manifest.json`: where
 * the task stood, and its archive commit when it had changes to keep.
 */
interface ArchiveManifest {
  version: 2;
  threadId: string;
  head: string;
  branch: string;
  createdAt: string;
  archive?: string;
}

/**
 * A snapshot from before 归档 kept only git's view: the whole directory copied
 * byte for byte, ignored files included. Still restored, never written.
 */
interface CopiedSnapshotManifest {
  version: 1;
  threadId: string;
  head: string;
  branch: string;
  createdAt: string;
  /** Every blob object the index referenced, saved under `objects/`. */
  indexObjects: string[];
}

type SnapshotManifest = ArchiveManifest | CopiedSnapshotManifest;

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


// --- removal ------------------------------------------------------------

const REMOVE_ATTEMPTS = 5;

/** A git process still inside the tree — a status probe re-creating `index.lock` — is worth another try. */
const retryableRemoval = (error: unknown): boolean =>
  /directory not empty|\bindex\.lock\b|unable to (?:create|write|append)[^\n]*\.lock|could not lock/i.test(error instanceof Error ? error.message : String(error));

const registered = async (repoPath: string, workspacePath: string): Promise<boolean> =>
  (await worktreeEntries(repoPath)).includes(`worktree ${workspacePath}`);

/**
 * `git worktree remove --force`, tolerating a git process that is still at
 * work inside the tree: the last rmdir fails with "Directory not empty", or a
 * lock is held. Done only once git no longer lists the worktree — a zero exit
 * from `prune` is not proof of that. Callers verify ownership first.
 */
async function removeRegistered(repoPath: string, workspacePath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((wake) => setTimeout(wake, Math.min(500, 100 * 2 ** (attempt - 1))));
    try {
      if (await exists(workspacePath)) await git(repoPath, ["worktree", "remove", "--force", "--", workspacePath]);
      // The tree is already gone; only the admin entry is left.
      else await git(repoPath, ["worktree", "prune"]);
      if (!(await registered(repoPath, workspacePath))) return;
      lastError = new GitError(`git worktree remove 之后 ${workspacePath} 仍在 git 的登记里`);
    } catch (error) {
      lastError = error;
      if (!retryableRemoval(error)) {
        if (!(await registered(repoPath, workspacePath))) return;
        throw error;
      }
    }
  }
  throw lastError;
}

// --- archive ------------------------------------------------------------

/**
 * What a worktree holds beyond its commit, as four trees: the commit's own,
 * the index, the tracked files as they are on disk, and the untracked files
 * that are not ignored. Written through temporary indexes — the real index and
 * HEAD are never touched.
 */
interface ArchiveTrees {
  baseCommit: string;
  baseTree: string;
  indexTree: string;
  workingTree: string;
  untrackedTree?: string;
}

const hasChanges = (trees: ArchiveTrees): boolean =>
  trees.indexTree !== trees.baseTree || trees.workingTree !== trees.baseTree || trees.untrackedTree != null;

const sameTrees = (a: ArchiveTrees, b: ArchiveTrees): boolean =>
  a.baseCommit === b.baseCommit &&
  a.baseTree === b.baseTree &&
  a.indexTree === b.indexTree &&
  a.workingTree === b.workingTree &&
  a.untrackedTree === b.untrackedTree;

const nulList = (output: string): string[] => output.split("\0").filter((entry) => entry.length > 0);

/** A `git diff --raw` line on either side of which sits a gitlink (mode 160000). */
const touchesGitlink = (raw: string): boolean => raw.split("\n").some((line) => /^:(?:160000 \d{6}|\d{6} 160000) /.test(line));

async function captureTrees(cwd: string): Promise<ArchiveTrees> {
  const baseCommit = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  const baseTree = (await git(cwd, ["rev-parse", "--verify", `${baseCommit}^{tree}`])).trim();
  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const indexTree = (
    await git(cwd, ["write-tree"]).catch((error: unknown) => {
      if (error instanceof Error && /unmerged/i.test(error.message)) {
        throw new ConflictError("暂存区里有没解决的冲突，先解决再归档；所有文件仍保留。", "workspace_unmerged");
      }
      throw error;
    })
  ).trim();
  const changed = nulList(await git(cwd, ["diff-files", "--name-only", "-z", "--"]));
  const untracked = nulList(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));

  const scratch = await mkdtemp(join(tmpdir(), "vgent-archive-"));
  try {
    // Only the paths git reported: a whole-tree `add -A` would walk every
    // nested checkout and ignored directory for nothing.
    const stage = async (name: string, start: string[], paths: string[]): Promise<string> => {
      const env = { GIT_INDEX_FILE: join(scratch, `${name}.index`) };
      await git(cwd, ["read-tree", ...start], env);
      if (paths.length > 0) {
        const list = join(scratch, `${name}.paths`);
        await writeFile(list, `${paths.join("\0")}\0`);
        await git(cwd, ["add", "-f", "-A", `--pathspec-from-file=${list}`, "--pathspec-file-nul"], { ...env, GIT_LITERAL_PATHSPECS: "1" });
      }
      return (await git(cwd, ["write-tree"], env)).trim();
    };
    const workingTree = await stage("working", [indexTree], changed);
    const untrackedTree = untracked.length > 0 ? await stage("untracked", ["--empty"], untracked) : undefined;

    // A gitlink names only a nested repository's commit, not the files
    // changed inside it: keep the directory rather than drop that work.
    if (
      touchesGitlink(await git(cwd, ["diff", "--raw", "--no-renames", baseTree, indexTree, "--"])) ||
      touchesGitlink(await git(cwd, ["diff", "--raw", "--no-renames", indexTree, workingTree, "--"])) ||
      (untrackedTree != null && /^160000 /m.test(await git(cwd, ["ls-tree", "-r", untrackedTree])))
    ) {
      throw new ConflictError("此任务包含 Git 子模块的改动，暂不回收其工作目录；所有文件仍保留。", "workspace_has_gitlink");
    }
    if (status.length > 0 && indexTree === baseTree && workingTree === baseTree && untrackedTree == null) {
      throw new ConflictError("工作目录里有 Git 记不下来的改动，暂不回收；所有文件仍保留。", "workspace_unrepresentable");
    }
    if ((await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim() !== baseCommit || (await git(cwd, ["write-tree"])).trim() !== indexTree) {
      throw new ConflictError("归档期间文件发生了变化，已保留工作目录。请停止外部编辑后重试。", "workspace_changed_during_snapshot");
    }
    return { baseCommit, baseTree, indexTree, workingTree, ...(untrackedTree != null ? { untrackedTree } : {}) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The four trees back out of an archive commit, laid out the way `git stash` lays out its own. */
async function treesOf(cwd: string, commit: string): Promise<ArchiveTrees> {
  const parse = (expression: string) =>
    git(cwd, ["rev-parse", "--verify", "--quiet", expression]).then(
      (output) => output.trim(),
      () => undefined,
    );
  const [baseCommit, baseTree, indexTree, workingTree, untrackedTree] = await Promise.all(
    [`${commit}^1`, `${commit}^1^{tree}`, `${commit}^2^{tree}`, `${commit}^{tree}`, `${commit}^3^{tree}`].map(parse),
  );
  if (baseCommit == null || baseTree == null || indexTree == null || workingTree == null) {
    throw new ConflictError("归档的改动已损坏，未恢复", "archive_corrupt");
  }
  return { baseCommit, baseTree, indexTree, workingTree, ...(untrackedTree != null ? { untrackedTree } : {}) };
}

async function commitTree(cwd: string, tree: string, parents: string[], message: string): Promise<string> {
  const args = ["commit-tree", "--no-gpg-sign", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message];
  return (await git(cwd, args, ARCHIVE_IDENTITY)).trim();
}

/** A commit shaped like a stash entry, so `git stash apply --index` knows how to put it back. */
async function archiveCommit(cwd: string, threadId: string, trees: ArchiveTrees): Promise<string> {
  const index = await commitTree(cwd, trees.indexTree, [trees.baseCommit], `Vgent 任务 ${threadId} 归档时的暂存区`);
  const untracked =
    trees.untrackedTree != null ? await commitTree(cwd, trees.untrackedTree, [], `Vgent 任务 ${threadId} 归档时的未跟踪文件`) : undefined;
  return commitTree(cwd, trees.workingTree, [trees.baseCommit, index, ...(untracked != null ? [untracked] : [])], `Vgent 任务 ${threadId} 归档时的改动`);
}

async function readManifest(dataDir: string, threadId: string, snapshotPath: string): Promise<SnapshotManifest> {
  const raw = await readFile(join(snapshotPath, "manifest.json"), "utf8").catch(() => undefined);
  if (raw == null) throw new NotFoundError("找不到归档快照", "snapshot_not_found");
  const manifest = JSON.parse(raw) as SnapshotManifest;
  if ((manifest.version !== 1 && manifest.version !== 2) || manifest.threadId !== threadId || dirname(snapshotPath) !== snapshotsDir(dataDir, threadId)) {
    throw new ConflictError("归档快照不属于此任务", "snapshot_not_owned");
  }
  return manifest;
}

/** The newest archive this task has, for a reclaim whose directory is already gone. */
async function latestArchive(dataDir: string, threadId: string): Promise<string | undefined> {
  let newest: { path: string; createdAt: string } | undefined;
  for (const entry of await readdir(snapshotsDir(dataDir, threadId)).catch(() => [])) {
    const path = join(snapshotsDir(dataDir, threadId), entry);
    const manifest = await readManifest(dataDir, threadId, path).catch(() => undefined);
    if (manifest?.version === 2 && (newest == null || manifest.createdAt > newest.createdAt)) newest = { path, createdAt: manifest.createdAt };
  }
  return newest?.path;
}

// --- reclaim / restore --------------------------------------------------

/**
 * How many paths `git status` lists in the worktree: the uncommitted work
 * 归档 would have to take along. Ignored files are not counted — 归档 never keeps them.
 */
export async function countUncommitted(workspacePath: string): Promise<number> {
  const entries = (await git(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
  let count = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry === "") continue;
    count += 1;
    // A rename or copy names its source in the next field.
    if (/^[RC]|^.[RC]/.test(entry)) index += 1;
  }
  return count;
}

export interface WorkspaceTaskOptions {
  dataDir: string;
  project: Project;
  thread: Pick<ThreadRecord, "id" | "workspace">;
}

/**
 * Keep the worktree's changes in git, then remove it. The branch and the
 * anchor ref stay: this gives the disk space back, it does not throw history
 * away. Ignored files go with the directory; the project's `worktrees.json`
 * rebuilds them on restore.
 *
 * A worktree with uncommitted changes is only taken with `preserveChanges`:
 * the user confirmed it, or nobody did and the directory stays as it is.
 */
export async function reclaimWorktree(
  options: WorkspaceTaskOptions & { preserveChanges?: boolean; onCaptured?: () => Promise<void> | void },
): Promise<{ snapshotPath: string }> {
  const { dataDir, project, thread } = options;
  const workspacePath = thread.workspace?.path;
  if (workspacePath == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");

  return locked(`workspace:${thread.id}`, () =>
    workspaceOperation(workspacePath, async () => {
      const owner = await verifyOwnership({ dataDir, project, thread, allowMissing: true });
      if (!(await exists(workspacePath))) {
        // A reclaim the last process finished but never got to record.
        const previous = await latestArchive(dataDir, thread.id);
        if (previous == null) throw new ConflictError("工作目录不存在", "workspace_missing");
        return { snapshotPath: previous };
      }

      const trees = await captureTrees(workspacePath);
      if (hasChanges(trees) && options.preserveChanges !== true) {
        throw new ConflictError("有没提交的改动，确认保留后才能归档；工作目录原样保留。", "archive_needs_confirmation");
      }
      const branch = await currentBranch(workspacePath);
      await options.onCaptured?.();
      const ref = archiveRef(thread.id);
      let archive: string | undefined;
      try {
        if (hasChanges(trees)) {
          archive = await archiveCommit(workspacePath, thread.id, trees);
          await git(workspacePath, ["update-ref", ref, archive]);
        } else {
          // Nothing to keep; a ref left over from an earlier attempt would be stale.
          await git(workspacePath, ["update-ref", "-d", ref]).catch(() => "");
        }
        if (!sameTrees(trees, await captureTrees(workspacePath))) {
          throw new ConflictError("归档期间文件发生了变化，已保留工作目录。请停止外部编辑后重试。", "workspace_changed_during_snapshot");
        }
      } catch (error) {
        if (archive != null) await git(workspacePath, ["update-ref", "-d", ref]).catch(() => "");
        throw error;
      }
      // HEAD stays reachable even if the branch moves on or is deleted before 取消归档.
      await git(workspacePath, ["update-ref", anchorRef(thread.id), trees.baseCommit]);

      const snapshotPath = join(snapshotsDir(dataDir, thread.id), randomUUID());
      await mkdir(snapshotPath, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(join(snapshotPath, "manifest.json"), {
        version: 2,
        threadId: thread.id,
        head: trees.baseCommit,
        branch,
        createdAt: new Date().toISOString(),
        ...(archive != null ? { archive } : {}),
      } satisfies ArchiveManifest);

      // Re-checked immediately before the only destructive call.
      await verifyOwnership({ dataDir, project, thread });
      await removeRegistered(owner.projectPath, workspacePath);
      return { snapshotPath };
    }),
  );
}

/** The recorded branch if nothing touched it since, or a fresh one at the recorded commit. */
async function branchFor(projectPath: string, manifest: SnapshotManifest, threadId: string): Promise<string> {
  let branchHead = "";
  try {
    branchHead = (await git(projectPath, ["rev-parse", "--verify", `refs/heads/${manifest.branch}`])).trim();
  } catch {
    // Deleted branch, or the snapshot was taken on a detached HEAD.
  }
  const branchIsFree = !(await worktreeEntries(projectPath)).includes(`branch refs/heads/${manifest.branch}`);
  // Never rewind or seize a branch somebody used after the reclaim.
  return branchHead === manifest.head && branchIsFree ? manifest.branch : `vgent/${threadId.slice(0, 8)}-restored-${randomUUID().slice(0, 8)}`;
}

/** Puts an archive commit's changes back onto a checkout of its base, and proves they landed. */
async function applyArchive(cwd: string, threadId: string, commit: string): Promise<void> {
  const current = await git(cwd, ["rev-parse", "--verify", "--quiet", archiveRef(threadId)]).then(
    (output) => output.trim(),
    () => undefined,
  );
  if (current != null && current !== commit) throw new ConflictError("归档的改动和记录对不上，未恢复", "archive_mismatch");
  await git(cwd, ["cat-file", "-e", `${commit}^{commit}`]).catch(() => {
    throw new NotFoundError("找不到归档的改动", "archive_missing");
  });
  const expected = await treesOf(cwd, commit);
  const live = await captureTrees(cwd);
  if (live.baseCommit !== expected.baseCommit) throw new ConflictError("任务分支已不在归档时的提交上，未恢复改动", "archive_base_moved");
  // A restore the last process got this far with: the changes are already back.
  if (sameTrees(live, expected)) return;
  if (hasChanges(live)) throw new ConflictError("工作目录里已有别的改动，未覆盖", "restore_conflict");
  await git(cwd, ["stash", "apply", "--index", commit]);
  if (!sameTrees(await captureTrees(cwd), expected)) throw new ConflictError("恢复的改动校验失败，归档仍保留", "restore_verify_failed");
}

async function restoreArchived(options: WorkspaceTaskOptions, owner: WorkspaceOwnership, manifest: ArchiveManifest): Promise<{ branch: string }> {
  const { dataDir, project, thread } = options;
  const workspacePath = thread.workspace?.path ?? "";

  let branch: string;
  let created: { minted: boolean } | undefined;
  if (await exists(workspacePath)) {
    // A restore the last process never got to record: the checkout is back,
    // the changes may or may not be.
    await verifyOwnership({ dataDir, project, thread });
    branch = await currentBranch(workspacePath);
  } else {
    await git(owner.projectPath, ["cat-file", "-e", `${manifest.head}^{commit}`]);
    branch = await branchFor(owner.projectPath, manifest, thread.id);
    const reuse = branch === manifest.branch;
    await git(owner.projectPath, ["worktree", "add", ...(reuse ? [] : ["-b", branch]), "--", workspacePath, reuse ? branch : manifest.head]);
    created = { minted: !reuse };
    await verifyOwnership({ dataDir, project, thread });
  }

  if (manifest.archive != null) {
    try {
      await applyArchive(workspacePath, thread.id, manifest.archive);
    } catch (error) {
      // The changes are still in the archive commit, so a clean retry beats a
      // half-restored directory.
      if (created != null) {
        await verifyOwnership({ dataDir, project, thread })
          .then(() => removeRegistered(owner.projectPath, workspacePath))
          .then(() => (created?.minted === true ? git(owner.projectPath, ["branch", "-D", "--", branch]) : ""))
          .catch(() => "");
      }
      throw error;
    }
  }
  await writeJsonAtomic(ownerPath(dataDir, thread.id), { ...owner, branch } satisfies WorkspaceOwnership, { mode: 0o600 });
  // Consumed: the changes live in the worktree again.
  await git(owner.projectPath, ["update-ref", "-d", archiveRef(thread.id)]).catch(() => "");
  return { branch };
}

/**
 * Put a reclaimed worktree back: its branch checked out again, then the
 * archived changes — index included — applied and verified tree for tree.
 * Ignored files are the caller's to rebuild, through the project's setup.
 */
export async function restoreWorktree(options: WorkspaceTaskOptions & { snapshotPath: string }): Promise<{ branch: string }> {
  const { dataDir, project, thread, snapshotPath } = options;
  const workspacePath = thread.workspace?.path;
  if (workspacePath == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");

  return locked(`workspace:${thread.id}`, () =>
    workspaceOperation(workspacePath, async () => {
      const owner = await verifyOwnership({ dataDir, project, thread, allowMissing: true });
      const manifest = await readManifest(dataDir, thread.id, snapshotPath);
      return manifest.version === 2
        ? restoreArchived(options, owner, manifest)
        : restoreCopied({ ...options, snapshotPath }, owner, manifest);
    }),
  );
}

/** A restored task's snapshot has served its purpose. Only ever under the task's own snapshots directory. */
export async function discardSnapshot(dataDir: string, threadId: string, snapshotPath: string): Promise<void> {
  if (dirname(snapshotPath) !== snapshotsDir(dataDir, threadId)) return;
  await rm(snapshotPath, { recursive: true, force: true });
}

// --- copied snapshots (before 归档 kept only git's view) ------------------

/**
 * A sha256 over every entry's path, mode, type, link target and bytes — the
 * whole tree including ignored files, `.git` excluded. Two directories with
 * the same digest hold the same files.
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
      } else throw new ConflictError(`目录包含不能校验的特殊文件：${name}`, "workspace_special_file");
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

/** The old way back, byte for byte: the same files, the same index, the same staged blobs. */
async function restoreCopied(
  options: WorkspaceTaskOptions & { snapshotPath: string },
  owner: WorkspaceOwnership,
  manifest: CopiedSnapshotManifest,
): Promise<{ branch: string }> {
  const { dataDir, project, thread, snapshotPath } = options;
  const workspacePath = thread.workspace?.path ?? "";
  if (await exists(workspacePath)) throw new ConflictError("恢复位置已有文件，未覆盖。请先处理该目录。", "workspace_occupied");
  await git(owner.projectPath, ["cat-file", "-e", `${manifest.head}^{commit}`]);

  const branch = await branchFor(owner.projectPath, manifest, thread.id);
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
}

// --- delete -------------------------------------------------------------

/**
 * Everything this task created, gone: the worktree, the anchor and archive
 * refs, the ownership file and the snapshots. The `vgent/<id8>` branch
 * survives unless it is still exactly the commit the task started from — a
 * branch with commits on it is history, and history is never deleted here.
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
          await removeRegistered(project.repoPath, workspace.path);
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
      await git(project.repoPath, ["update-ref", "-d", archiveRef(thread.id)]).catch(() => "");
      await rm(snapshotsDir(dataDir, thread.id), { recursive: true, force: true });
      await rm(ownerPath(dataDir, thread.id), { force: true });
      return result;
    }),
  );
}
