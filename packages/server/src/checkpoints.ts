/**
 * Checkpoint: 每个回合开始前给工作目录打快照，「恢复到此处」把文件放回去.
 *
 * A checkpoint is an ordinary git commit of the whole working directory —
 * tracked and untracked alike, ignored files never — kept alive by a ref under
 * `refs/vgent/checkpoints/<threadId>/`. Nothing here touches the user's own
 * index, HEAD or branches: every tree is built through a throwaway
 * `GIT_INDEX_FILE`, and a restore writes files straight out of the target tree.
 *
 * Projects that are not git repositories are allowed in Vgent, so every entry
 * point here answers `undefined` for one instead of failing the turn.
 */
import { copyFile, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCommand, type ToolExec } from "./exec.js";
import type { Logger } from "./types.js";
import { silentLogger } from "./types.js";

/** Snapshots run inside a turn's critical path; a minute is already generous. */
const GIT_TIMEOUT_MS = 60_000;

/** How many checkpoint refs one thread keeps before the oldest are dropped. */
export const CHECKPOINT_RETENTION = 50;

/** How many paths one `checkout-index` call takes; keeps the argv well short of its limit. */
const CHECKOUT_BATCH = 500;

const REF_ROOT = "refs/vgent/checkpoints";

/** Every ref one thread's checkpoints live under. */
export const checkpointRefPrefix = (threadId: string): string => `${REF_ROOT}/${threadId}`;

/**
 * A fixed identity, forced through the environment: a repo without a
 * `user.name` must still be able to take a checkpoint.
 */
const IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "Vgent",
  GIT_AUTHOR_EMAIL: "vgent@localhost",
  GIT_COMMITTER_NAME: "Vgent",
  GIT_COMMITTER_EMAIL: "vgent@localhost",
};

const COMMIT_MESSAGE = "vgent checkpoint";

/** One taken checkpoint: the commit that holds the tree, and the ref that keeps it. */
export interface Checkpoint {
  commit: string;
  ref: string;
}

/** Shared by every entry point: where to run, and who to blame when it fails. */
interface GitOptions {
  repoPath: string;
  /** Defaults to the real `execFile`; tests may answer for git themselves. */
  exec?: ToolExec;
  log?: Logger;
}

class CheckpointGitError extends Error {}

/** A git runner bound to one directory, plus the variant that insists it worked. */
function gitIn(repoPath: string, exec: ToolExec) {
  const run = (args: readonly string[], env?: NodeJS.ProcessEnv) =>
    exec("git", args, { cwd: repoPath, timeout: GIT_TIMEOUT_MS, ...(env != null ? { env } : {}) });
  const ok = async (args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> => {
    const result = await run(args, env);
    if (result.code !== 0) throw new CheckpointGitError(`git ${args.join(" ")} 失败: ${result.stderr.trim().slice(-500)}`);
    return result.stdout;
  };
  return { run, ok };
}

/** Drops the trailing empty field every `-z` record list ends with. */
function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Whether `repoPath` is inside a git work tree at all. */
async function isRepo(repoPath: string, exec: ToolExec): Promise<boolean> {
  const result = await gitIn(repoPath, exec).run(["rev-parse", "--is-inside-work-tree"]);
  return result.code === 0 && result.stdout.trim() === "true";
}

/**
 * The whole working directory as a tree object, without touching the real
 * index: tracked files, untracked files, no ignored ones.
 *
 * The scratch index is *seeded from the real one* — with git's stat cache in
 * place `add -A` re-hashes only what actually changed, which is what keeps this
 * off a large repo's critical path. A missing or unreadable index just means
 * starting empty, which produces the same tree, only slower.
 */
export async function snapshotTree(repoPath: string, exec: ToolExec = runCommand): Promise<string> {
  const git = gitIn(repoPath, exec);
  const scratch = await mkdtemp(join(tmpdir(), "vgent-tree-"));
  try {
    const indexFile = join(scratch, "index");
    const located = await git.run(["rev-parse", "--git-path", "index"]);
    if (located.code === 0) {
      const real = resolve(repoPath, located.stdout.trim());
      await copyFile(real, indexFile).catch(() => {});
    }
    const env = { GIT_INDEX_FILE: indexFile };
    await git.ok(["add", "-A"], env);
    return (await git.ok(["write-tree"], env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** `<prefix>/<n>` and `<prefix>/undo-<n>` → n. Anything else is not ours. */
function refCounter(ref: string, prefix: string): number | undefined {
  if (!ref.startsWith(`${prefix}/`)) return undefined;
  const match = /^(?:undo-)?(\d+)$/.exec(ref.slice(prefix.length + 1));
  if (match?.[1] == null) return undefined;
  return Number.parseInt(match[1], 10);
}

interface RefEntry {
  ref: string;
  commit: string;
  counter: number;
}

/** One thread's checkpoint refs, oldest first. Empty for a non-git directory. */
async function listRefs(repoPath: string, threadId: string, exec: ToolExec): Promise<RefEntry[]> {
  const prefix = checkpointRefPrefix(threadId);
  const result = await gitIn(repoPath, exec).run(["for-each-ref", "--format=%(refname)%00%(objectname)", "--", `${prefix}/`]);
  if (result.code !== 0) return [];
  const entries: RefEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [ref = "", commit = ""] = line.split("\0");
    const counter = refCounter(ref, prefix);
    if (counter == null || commit === "") continue;
    entries.push({ ref, commit, counter });
  }
  return entries.sort((a, b) => a.counter - b.counter);
}

/** The commits one thread may be restored to — nothing else is ever checked out. */
export async function listCheckpointCommits(options: { repoPath: string; threadId: string; exec?: ToolExec }): Promise<string[]> {
  const entries = await listRefs(options.repoPath, options.threadId, options.exec ?? runCommand);
  return entries.map((entry) => entry.commit);
}

/**
 * Snapshot `repoPath` and keep it under a new ref for this thread.
 *
 * `undefined` means there is no checkpoint for this turn — a directory that is
 * not a git repo, or a git call that failed. Never throws: a snapshot we could
 * not take must not cost the user their turn.
 */
export async function createCheckpoint(options: GitOptions & {
  threadId: string;
  /** The safety copy a restore takes of the state it is about to replace. */
  undo?: boolean;
}): Promise<Checkpoint | undefined> {
  const { repoPath, threadId } = options;
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;
  try {
    if (!(await isRepo(repoPath, exec))) return undefined;
    const git = gitIn(repoPath, exec);
    const tree = await snapshotTree(repoPath, exec);
    // An unborn HEAD has no parent to hang the checkpoint off; the tree alone
    // is all a restore ever reads.
    const head = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    const parent = head.code === 0 ? head.stdout.trim() : "";
    const commit = (
      await git.ok(["commit-tree", tree, ...(parent === "" ? [] : ["-p", parent]), "-m", COMMIT_MESSAGE], IDENTITY)
    ).trim();

    const existing = await listRefs(repoPath, threadId, exec);
    const next = (existing.at(-1)?.counter ?? 0) + 1;
    const name = `${options.undo === true ? "undo-" : ""}${String(next).padStart(6, "0")}`;
    const ref = `${checkpointRefPrefix(threadId)}/${name}`;
    await git.ok(["update-ref", ref, commit]);

    // Retention counts both kinds together: they share one counter, so "newest
    // 50" is a single ordering.
    const stale = [...existing, { ref, commit, counter: next }].slice(0, -CHECKPOINT_RETENTION);
    for (const entry of stale) await git.run(["update-ref", "-d", entry.ref, entry.commit]);

    return { commit, ref };
  } catch (error) {
    log.warn(`线程 ${threadId} 的工作目录快照失败`, error);
    return undefined;
  }
}

/** Forget every checkpoint of one thread. For a deleted task. */
export async function deleteCheckpoints(options: GitOptions & { threadId: string }): Promise<number> {
  const { repoPath, threadId } = options;
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;
  try {
    const git = gitIn(repoPath, exec);
    const entries = await listRefs(repoPath, threadId, exec);
    let removed = 0;
    for (const entry of entries) {
      const result = await git.run(["update-ref", "-d", entry.ref, entry.commit]);
      if (result.code === 0) removed += 1;
    }
    return removed;
  } catch (error) {
    log.warn(`清理线程 ${threadId} 的快照引用失败`, error);
    return 0;
  }
}

/** What a restore moved, for the log line. */
export interface RestoreResult {
  written: number;
  deleted: number;
}

/** `rmdir` upwards from a removed file, stopping at the repo root or the first non-empty parent. */
async function pruneEmptyDirs(repoPath: string, path: string): Promise<void> {
  const root = resolve(repoPath);
  let dir = dirname(resolve(root, path));
  while (dir !== root && dir.startsWith(root)) {
    const gone = await rmdir(dir).then(
      () => true,
      () => false,
    );
    if (!gone) return;
    dir = dirname(dir);
  }
}

/**
 * Make the working directory match the checkpoint's tree.
 *
 * Neither the real index nor HEAD moves: the difference between the target tree
 * and a fresh snapshot of the tree as it is now names the files, and each one is
 * either written out of the target (through a scratch index) or removed from
 * disk. Ignored files are in neither tree, so they are never touched.
 */
export async function restoreCheckpoint(options: GitOptions & { commit: string }): Promise<RestoreResult> {
  const { repoPath, commit } = options;
  const exec = options.exec ?? runCommand;
  const git = gitIn(repoPath, exec);

  const current = await snapshotTree(repoPath, exec);
  const diff = await git.ok(["diff", "--name-status", "-z", "--no-renames", commit, current]);

  const tokens = splitNul(diff);
  /** Present only in the tree as it is now — the checkpoint did not have them. */
  const deletions: string[] = [];
  /** Everything else comes back out of the target tree, content and mode alike. */
  const writes: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const letter = tokens[i]?.[0];
    const path = tokens[++i];
    if (letter == null || path == null || path.length === 0) continue;
    if (letter === "A") deletions.push(path);
    else writes.push(path);
  }

  if (writes.length > 0) {
    const scratch = await mkdtemp(join(tmpdir(), "vgent-restore-"));
    try {
      const env = { GIT_INDEX_FILE: join(scratch, "index") };
      await git.ok(["read-tree", commit], env);
      // `checkout-index` creates the leading directories and restores file modes
      // and symlinks by itself. The paths are batched so a restore spanning a
      // few thousand files never runs into the command-line length limit.
      for (let i = 0; i < writes.length; i += CHECKOUT_BATCH) {
        await git.ok(["checkout-index", "-f", "--", ...writes.slice(i, i + CHECKOUT_BATCH)], env);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  for (const path of deletions) {
    await rm(resolve(repoPath, path), { force: true, recursive: false });
    await pruneEmptyDirs(repoPath, path);
  }

  return { written: writes.length, deleted: deletions.length };
}
