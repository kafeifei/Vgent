/**
 * Checkpoint: 每个回合前后各给工作目录打一次快照，「恢复到此处」把文件放回去.
 *
 * A checkpoint is an ordinary git commit of the whole working directory —
 * tracked and untracked alike, ignored files never — kept alive by a ref under
 * `refs/vgent/checkpoints/<threadId>/`. Nothing here touches the user's own
 * index, HEAD or branches: every tree is built through a throwaway
 * `GIT_INDEX_FILE`, and a restore writes files straight out of the target tree.
 *
 * One turn owns one counter and up to two refs: `<n>` is the tree it started
 * from and `after-<n>` the tree it ended with, so the files that turn touched
 * are the difference between them — which is all 「只回退任务动过的文件」 needs.
 * `undo-<n>` is a counter of its own: the safety copy a restore takes.
 *
 * Projects that are not git repositories are allowed in Vgent, so every entry
 * point here answers `undefined` for one instead of failing the turn.
 */
import { copyFile, lstat, mkdtemp, rm, rmdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCommand, type ToolExec } from "./exec.js";
import type { Logger } from "./types.js";
import { silentLogger } from "./types.js";

/** Snapshots run inside a turn's critical path; a minute is already generous. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * How many *turns* one thread keeps checkpoints for before the oldest are
 * dropped. Counted in counters, not refs: a turn's before- and after-snapshot
 * share one, so adding the second snapshot did not halve the history.
 */
export const CHECKPOINT_RETENTION = 50;

/** How many paths one `checkout-index` call takes; keeps the argv well short of its limit. */
const CHECKOUT_BATCH = 500;

const REF_ROOT = "refs/vgent/checkpoints";

/** Every ref one thread's checkpoints live under. */
export const checkpointRefPrefix = (threadId: string): string => `${REF_ROOT}/${threadId}`;

/** Where one thread's 任务基线 is pinned. Deliberately not a numbered checkpoint: retention leaves it alone. */
export const baselineRef = (threadId: string): string => `${checkpointRefPrefix(threadId)}/base`;

/**
 * The scope 带回主目录 takes its undo snapshot under.
 *
 * It is a checkpoint like any other, but of the *project* checkout rather than
 * the task's worktree — and a linked worktree shares one ref store with its
 * project, so the two would otherwise land in the same numbered series and
 * 「恢复到此处」 would happily offer the user the wrong directory's state. A
 * sub-scope keeps them apart: `listRefs` only counts `<prefix>/<n>`, so nothing
 * here is ever restorable as a turn checkpoint, while `deleteCheckpoints` on the
 * thread still sweeps it up. 撤销带回 keeps its own safety copy (`undo-<n>`) of
 * the checkout it is about to overwrite here too.
 */
export const applyUndoScope = (threadId: string): string => `${threadId}/apply`;

/**
 * The scope 全部丢弃 keeps what it is about to throw away under: the task's
 * commits (the checkpoint's parent is HEAD) and its working tree. A discard
 * cannot be undone from the UI, but it must not be the end of the work either —
 * `git branch recovered <ref>` gets it back — and `deleteCheckpoints` on the
 * thread sweeps it up with the rest.
 */
export const discardScope = (threadId: string): string => `${threadId}/discard`;

/**
 * The scope a per-file 还原 keeps the directory under, as it was just before. The
 * file goes back to the baseline, and whatever the user typed into it after the
 * task started goes with it; one snapshot keeps that text findable
 * (`git restore --source <ref> -- <path>`). Bounded like every scope: the oldest
 * are dropped after fifty.
 */
export const revertScope = (threadId: string): string => `${threadId}/revert`;

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
 * What `git add --ignore-errors` reports for a file it could not index — one we
 * may not read, an embedded repository that has no commit to point at. It still
 * exits 1 for them, so the exit code alone cannot tell them from a real failure;
 * the messages can.
 */
const UNINDEXABLE = /^error: (?:open\(".*"\): .*|unable to index file '.*'|'.*' does not have a commit checked out)$/;

/**
 * `warning:` and `hint:` lines are git talking, not failing: an embedded
 * repository *with* a commit is added as a link with a page of advice, and when
 * an unreadable file is in the same run the exit code is 1 with both in stderr.
 */
const ADVICE = /^(?:warning|hint):/;

const onlyUnindexable = (stderr: string): boolean =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !ADVICE.test(line))
    .every((line) => UNINDEXABLE.test(line));

/**
 * The whole working directory as a tree object, without touching the real
 * index: tracked files, untracked files, no ignored ones.
 *
 * A file that cannot be indexed is left out of the tree rather than failing the
 * snapshot: one unreadable file or one just-cloned nested repository would
 * otherwise take out every panel, commit and 带回 that starts from a snapshot.
 *
 * The scratch index is *seeded from the real one* — with git's stat cache in
 * place `add -A` re-hashes only what actually changed, which is what keeps this
 * off a large repo's critical path. A missing or unreadable index just means
 * starting empty, which produces the same tree, only slower.
 *
 * The copy keeps the real index's own mtime, and that is load-bearing: git
 * compares whole seconds, so a file written in the same second as the index
 * looks unchanged by its stat alone. Git catches that with the index's
 * timestamp (an entry at or after it is re-hashed) — a copy with a fresh mtime
 * would throw that safety net away and silently snapshot the old content.
 */
export async function snapshotTree(repoPath: string, exec: ToolExec = runCommand): Promise<string> {
  const git = gitIn(repoPath, exec);
  const scratch = await mkdtemp(join(tmpdir(), "vgent-tree-"));
  try {
    const indexFile = join(scratch, "index");
    const located = await git.run(["rev-parse", "--git-path", "index"]);
    if (located.code === 0) {
      const real = resolve(repoPath, located.stdout.trim());
      const info = await stat(real).catch(() => null);
      await copyFile(real, indexFile).catch(() => {});
      if (info != null) await utimes(indexFile, info.atime, info.mtime).catch(() => {});
    }
    const env = { GIT_INDEX_FILE: indexFile };
    const add = await git.run(["add", "-A", "--ignore-errors"], env);
    if (add.code !== 0 && !onlyUnindexable(add.stderr)) {
      throw new CheckpointGitError(`git add -A --ignore-errors 失败: ${add.stderr.trim().slice(-500)}`);
    }
    return (await git.ok(["write-tree"], env)).trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** What a numbered ref of one turn is: the tree before it, the tree after it, or a restore's safety copy. */
type RefKind = "before" | "after" | "undo";

/** `<prefix>/<n>`, `<prefix>/after-<n>` and `<prefix>/undo-<n>`. Anything else is not ours. */
function parseRef(ref: string, prefix: string): { counter: number; kind: RefKind } | undefined {
  if (!ref.startsWith(`${prefix}/`)) return undefined;
  const match = /^(after-|undo-)?(\d+)$/.exec(ref.slice(prefix.length + 1));
  if (match?.[2] == null) return undefined;
  const kind: RefKind = match[1] === "after-" ? "after" : match[1] === "undo-" ? "undo" : "before";
  return { counter: Number.parseInt(match[2], 10), kind };
}

/** The `after-` ref paired with a before-checkpoint's own, or undefined when that ref is not a numbered one. */
function afterRefFor(beforeRef: string, prefix: string): string | undefined {
  const parsed = parseRef(beforeRef, prefix);
  if (parsed == null || parsed.kind !== "before") return undefined;
  return `${prefix}/after-${String(parsed.counter).padStart(6, "0")}`;
}

interface RefEntry {
  ref: string;
  commit: string;
  counter: number;
  kind: RefKind;
}

/** Everything one thread keeps under its prefix, the 基线 ref included. Empty for a non-git directory. */
async function listAllRefs(repoPath: string, threadId: string, exec: ToolExec): Promise<{ ref: string; commit: string }[]> {
  const prefix = checkpointRefPrefix(threadId);
  const result = await gitIn(repoPath, exec).run(["for-each-ref", "--format=%(refname)%00%(objectname)", "--", `${prefix}/`]);
  if (result.code !== 0) return [];
  const entries: { ref: string; commit: string }[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [ref = "", commit = ""] = line.split("\0");
    if (ref === "" || commit === "") continue;
    entries.push({ ref, commit });
  }
  return entries;
}

/**
 * One thread's *numbered* checkpoint refs, oldest first. The 基线 ref has no
 * counter, so it is not one of these — which is exactly what keeps retention
 * from ever dropping it.
 */
async function listRefs(repoPath: string, threadId: string, exec: ToolExec): Promise<RefEntry[]> {
  const prefix = checkpointRefPrefix(threadId);
  const entries: RefEntry[] = [];
  for (const { ref, commit } of await listAllRefs(repoPath, threadId, exec)) {
    const parsed = parseRef(ref, prefix);
    if (parsed == null) continue;
    entries.push({ ref, commit, ...parsed });
  }
  return entries.sort((a, b) => a.counter - b.counter);
}

/**
 * Every snapshot one thread still has: what a restore may be pointed at, and
 * what a span may be diffed against. Retention is the only thing that takes a
 * commit off this list, and a request naming anything not on it is refused
 * rather than checked out — an arbitrary sha never reaches the working tree.
 */
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

    // Retention is 50 *counters*, not 50 refs: a turn's `after-` snapshot rides
    // along on the counter its before-snapshot opened, so it is dropped with it
    // and never on its own — a half-kept turn would degrade to a whole-tree
    // restore for no reason.
    const entries: RefEntry[] = [...existing, { ref, commit, counter: next, kind: options.undo === true ? "undo" : "before" }];
    const stale = new Set([...new Set(entries.map((entry) => entry.counter))].sort((a, b) => a - b).slice(0, -CHECKPOINT_RETENTION));
    for (const entry of entries) {
      if (stale.has(entry.counter)) await git.run(["update-ref", "-d", entry.ref, entry.commit]);
    }

    return { commit, ref };
  } catch (error) {
    log.warn(`线程 ${threadId} 的工作目录快照失败`, error);
    return undefined;
  }
}

/**
 * 回合结束后的快照, taken once a turn is really over — finished, failed or
 * stopped. Paired with the turn's own before-snapshot by counter (`after-<n>`
 * next to `<n>`), and committed *on top of* it, so `git diff <before> <after>`
 * names exactly the files that turn touched.
 *
 * `undefined` — never a throw — when the before-checkpoint is not one of this
 * thread's numbered refs, when the directory is not a git repo, or when a git
 * call failed. The span that turn belongs to then falls back to a whole-tree
 * restore, which is what Vgent did before there were after-snapshots at all.
 */
export async function createAfterCheckpoint(options: GitOptions & { threadId: string; before: Checkpoint }): Promise<Checkpoint | undefined> {
  const { repoPath, threadId } = options;
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;
  try {
    const ref = afterRefFor(options.before.ref, checkpointRefPrefix(threadId));
    if (ref == null) return undefined;
    if (!(await isRepo(repoPath, exec))) return undefined;
    const git = gitIn(repoPath, exec);
    const tree = await snapshotTree(repoPath, exec);
    const commit = (await git.ok(["commit-tree", tree, "-p", options.before.commit, "-m", COMMIT_MESSAGE], IDENTITY)).trim();
    await git.ok(["update-ref", ref, commit]);
    return { commit, ref };
  } catch (error) {
    log.warn(`线程 ${threadId} 的回合结束快照失败`, error);
    return undefined;
  }
}

/**
 * 一个回合动过的文件: the paths that differ between two checkpoint trees.
 *
 * `--no-renames` on purpose — a restore has to be able to put both halves of a
 * rename back, so it needs the old path listed as well as the new one.
 */
export async function changedPaths(options: GitOptions & { from: string; to: string }): Promise<string[]> {
  const git = gitIn(options.repoPath, options.exec ?? runCommand);
  return splitNul(await git.ok(["diff", "--name-only", "-z", "--no-renames", options.from, options.to])).filter((path) => path.length > 0);
}

/**
 * 任务基线 of a main-checkout task: the state its first turn started from,
 * pinned under a ref of its own so the 50-checkpoint retention never drops it.
 *
 * `commit` re-uses a snapshot already taken (the task's first checkpoint);
 * without it the working directory is snapshotted afresh — what 提交 does to
 * move the baseline past what it just committed. `undefined` — never a throw —
 * for a directory that is not a git repo, or a git call that failed.
 */
export async function pinBaseline(options: GitOptions & { threadId: string; commit?: string }): Promise<string | undefined> {
  const { repoPath, threadId } = options;
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;
  try {
    if (!(await isRepo(repoPath, exec))) return undefined;
    const git = gitIn(repoPath, exec);
    let commit = options.commit;
    if (commit == null) {
      const tree = await snapshotTree(repoPath, exec);
      const head = await git.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
      const parent = head.code === 0 ? head.stdout.trim() : "";
      commit = (await git.ok(["commit-tree", tree, ...(parent === "" ? [] : ["-p", parent]), "-m", COMMIT_MESSAGE], IDENTITY)).trim();
    }
    await git.ok(["update-ref", baselineRef(threadId), commit]);
    return commit;
  } catch (error) {
    log.warn(`线程 ${threadId} 的任务基线记录失败`, error);
    return undefined;
  }
}

/** Forget every checkpoint of one thread — the 基线 ref with them. For a deleted task. */
export async function deleteCheckpoints(options: GitOptions & { threadId: string }): Promise<number> {
  const { repoPath, threadId } = options;
  const exec = options.exec ?? runCommand;
  const log = options.log ?? silentLogger;
  try {
    const git = gitIn(repoPath, exec);
    const entries = await listAllRefs(repoPath, threadId, exec);
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
export async function pruneEmptyDirs(repoPath: string, path: string): Promise<void> {
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
 *
 * `paths` narrows it to those files and leaves every other difference alone —
 * what 撤销带回 needs, since it may only put back the files its own apply wrote.
 */
export async function restoreCheckpoint(options: GitOptions & { commit: string; paths?: readonly string[] }): Promise<RestoreResult> {
  const { repoPath, commit } = options;
  const exec = options.exec ?? runCommand;
  const git = gitIn(repoPath, exec);
  const only = options.paths == null ? undefined : new Set(options.paths);

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
    if (only != null && !only.has(path)) continue;
    if (letter === "A") deletions.push(path);
    else writes.push(path);
  }

  // Deletions first. Where the disk ignores case, `README.md` in the tree as it
  // is now and `Readme.md` in the checkpoint are one file: removed after the
  // write, it would take the restored file with it. A path that changed between
  // file and directory, too, wants the old shape gone before the new one is written.
  for (const path of deletions) {
    // Only a file or a link: a nested repository is in the tree as a link to its
    // commit but on disk a directory, and `rm` on one would throw halfway through.
    const info = await lstat(resolve(repoPath, path)).catch(() => null);
    if (info != null && !info.isFile() && !info.isSymbolicLink()) continue;
    await rm(resolve(repoPath, path), { force: true, recursive: false });
    await pruneEmptyDirs(repoPath, path);
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

  return { written: writes.length, deleted: deletions.length };
}
