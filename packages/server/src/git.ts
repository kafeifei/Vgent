/**
 * The 「变更」panel's data source: one repo against a task's baseline.
 *
 * A worktree task's baseline is its `baseCommit`, a commit the checkout
 * descends from: staged and unstaged work is merged (`git diff <base>` compares
 * the baseline straight to the working tree, which is exactly that), plus
 * untracked files with `.gitignore` honoured — so everything the task did
 * counts, its own commits included.
 *
 * A main-checkout task's baseline is instead a *snapshot* of the working
 * directory as its first turn found it (`{ tree }`). There the comparison runs
 * tree against tree: the user's own untracked files are already in the baseline
 * tree, and listing untracked files separately would count them as the task's.
 * Everything shells out to the real `git`; no libgit, no cache.
 */
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { snapshotTree } from "./checkpoints.js";
import { BadRequestError, GitError, GitUnavailableError, NotAGitRepoError, NotFoundError } from "./errors.js";

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Only for `renamed`: where the file came from in HEAD. */
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesSnapshot {
  repoPath: string;
  /** `null` when HEAD is detached. */
  branch: string | null;
  files: ChangedFile[];
}

/** `GET /threads/:id/changes`: the snapshot, plus whether 「上一轮」 has anything to show. */
export interface ChangesResponse extends ChangesSnapshot {
  lastTurn?: boolean;
}

export interface FileDiff {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  binary: boolean;
  /** Unified diff as git prints it; empty for binary files. */
  diff: string;
  truncated: boolean;
}

/**
 * 任务基线: what one task's changes are measured against.
 *
 * A string is a commit-ish the working tree descends from. `{ tree }` is a
 * snapshot of a working directory — a main-checkout task's baseline, compared
 * tree to tree. `{ from, to }` is two snapshots against each other and never
 * looks at the working directory at all — what 「上一轮」 shows. `{ none: true }`
 * is a task that has no baseline yet, so it cannot have changed anything.
 */
export type DiffBase = string | { tree: string } | { from: string; to: string } | { none: true };

export interface Git {
  /** The branch a checkout is on right now; `null` when HEAD is detached. */
  branch(repoPath: string): Promise<string | null>;
  /** `base` defaults to HEAD, or the empty tree in a repo with no commit yet. */
  changes(repoPath: string, base?: DiffBase): Promise<ChangesSnapshot>;
  fileDiff(repoPath: string, path: string, base?: DiffBase): Promise<FileDiff>;
  revert(repoPath: string, path: string, base?: DiffBase): Promise<{ path: string }>;
}

export interface CreateGitOptions {
  /** Per-git-invocation timeout. */
  timeoutMs?: number;
  /** Cut-off for a single file's diff text. */
  maxDiffBytes?: number;
}

/** `git hash-object -t tree /dev/null` — the diff base when HEAD is unborn. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 500;
/** How much of an untracked file we sniff for NUL bytes. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Above this we do not read an untracked file just to count its lines. */
const MAX_COUNT_BYTES = 4 * 1024 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A resolved `DiffBase`: the left-hand rev, and the right-hand one — the working tree when absent. */
interface DiffPair {
  base: string;
  tree?: string;
}

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
}

const trimStderr = (stderr: string): string => stderr.trim().slice(0, MAX_STDERR_CHARS);

/** Drops the trailing empty field every `-z` record list ends with. */
function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * Line count the way git's `--numstat` reports a new file: one per `\n`, plus
 * one more when the last line has no terminator.
 */
function countLines(buffer: Buffer): number {
  let lines = 0;
  for (const byte of buffer) if (byte === 0x0a) lines += 1;
  if (buffer.length > 0 && buffer.at(-1) !== 0x0a) lines += 1;
  return lines;
}

/** A `git diff --name-status` letter. `T` (typechange) and `U` (unmerged) read as plain edits. */
function letterStatus(letter: string): ChangeStatus {
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R" || letter === "C") return "renamed";
  return "modified";
}

export function createGit(options: CreateGitOptions = {}): Git {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;

  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

  /** Runs git in `repoPath`. Exit codes in `allowExit` come back as results, everything else throws. */
  async function run(repoPath: string, args: string[], allowExit: readonly number[] = []): Promise<GitResult> {
    const settled = await new Promise<{ error: ExecError | null; stdout: string; stderr: string }>((done) => {
      execFile("git", args, { cwd: repoPath, timeout, maxBuffer: MAX_BUFFER, encoding: "utf8", env }, (error, stdout, stderr) =>
        done({ error: error as ExecError | null, stdout, stderr }),
      );
    });
    const { error, stdout, stderr } = settled;
    if (error == null) return { code: 0, stdout, stderr };
    if (error.code === "ENOENT") throw new GitUnavailableError();
    if (error.killed === true) throw new GitError(`git 超时（${timeout}ms）: git ${args.join(" ")}`);
    if (typeof error.code === "number" && allowExit.includes(error.code)) return { code: error.code, stdout, stderr };
    throw new GitError(`git ${args.join(" ")} 失败: ${trimStderr(stderr) || error.message}`);
  }

  /** Fails loudly unless `repoPath` is a directory inside a work tree. */
  async function assertRepo(repoPath: string): Promise<void> {
    if (!(await stat(repoPath).catch(() => null))?.isDirectory()) {
      throw new NotAGitRepoError(`仓库路径不是目录: ${repoPath}`);
    }
    const result = await run(repoPath, ["rev-parse", "--is-inside-work-tree"], [1, 128]);
    if (result.code !== 0 || result.stdout.trim() !== "true") throw new NotAGitRepoError(`不是 git 仓库: ${repoPath}`);
  }

  /**
   * The caller's baseline resolved into the two sides every diff below runs on.
   *
   * No baseline at all means `HEAD` — the empty tree when the repo has no commit
   * yet. A task with no baseline is the empty tree against itself: no changes,
   * which is exactly what it has.
   */
  async function diffPair(repoPath: string, base?: DiffBase): Promise<DiffPair> {
    if (base == null) {
      const head = await run(repoPath, ["rev-parse", "--quiet", "--verify", "HEAD"], [1]);
      return { base: head.code === 0 && head.stdout.trim().length > 0 ? "HEAD" : EMPTY_TREE };
    }
    if (typeof base === "string") return { base };
    if ("tree" in base) return { base: base.tree, tree: await snapshotTree(repoPath) };
    if ("from" in base) return { base: base.from, tree: base.to };
    return { base: EMPTY_TREE, tree: EMPTY_TREE };
  }

  /** The rev arguments of one `git diff`: a base, and the right-hand side when it is not the working tree. */
  const revs = (pair: DiffPair): string[] => (pair.tree == null ? [pair.base] : [pair.base, pair.tree]);

  async function currentBranch(repoPath: string): Promise<string | null> {
    const result = await run(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"], [1]);
    const name = result.stdout.trim();
    return result.code === 0 && name.length > 0 ? name : null;
  }

  async function isInIndex(repoPath: string, path: string): Promise<boolean> {
    const result = await run(repoPath, ["ls-files", "--error-unmatch", "-z", "--", path], [1]);
    return result.code === 0;
  }

  /** `path` → `[additions, deletions, binary]` for everything the diff covers, keyed by the post-image path. */
  async function numstat(repoPath: string, pair: DiffPair): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
    const result = await run(repoPath, ["diff", ...revs(pair), "--numstat", "-z", "-M", "--no-color"]);
    const tokens = splitNul(result.stdout);
    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token == null) continue;
      const first = token.indexOf("\t");
      const second = token.indexOf("\t", first + 1);
      if (first < 0 || second < 0) continue;
      const added = token.slice(0, first);
      const deleted = token.slice(first + 1, second);
      // With `-z` a rename leaves the path field empty and follows with two records.
      let path = token.slice(second + 1);
      if (path.length === 0) {
        i += 2;
        path = tokens[i] ?? "";
      }
      const binary = added === "-" || deleted === "-";
      counts.set(path, {
        additions: binary ? 0 : Number.parseInt(added, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
        binary,
      });
    }
    return counts;
  }

  /** Untracked files have no diff to count, so we read them. */
  async function untrackedCounts(repoPath: string, path: string): Promise<{ additions: number; binary: boolean }> {
    const absolute = resolve(repoPath, path);
    const info = await stat(absolute).catch(() => null);
    if (info == null || !info.isFile() || info.size > MAX_COUNT_BYTES) return { additions: 0, binary: false };
    const buffer = await readFile(absolute).catch(() => null);
    if (buffer == null) return { additions: 0, binary: false };
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { additions: 0, binary: true };
    return { additions: countLines(buffer), binary: false };
  }

  /** The snapshot for an already-resolved baseline, so one request never snapshots the tree twice. */
  async function changesWith(repoPath: string, pair: DiffPair): Promise<ChangesSnapshot> {
    const [branch, counts, nameStatus, others] = await Promise.all([
      currentBranch(repoPath),
      numstat(repoPath, pair),
      run(repoPath, ["diff", ...revs(pair), "--name-status", "-z", "-M", "--no-color"]),
      // A tree-to-tree diff already carries the untracked files of both sides;
      // listing them again would count the user's own as the task's.
      pair.tree == null ? run(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]) : undefined,
    ]);

    const tokens = splitNul(nameStatus.stdout);
    const files: ChangedFile[] = [];

    // `-z` puts the status letter in its own record, followed by one path — or,
    // for a rename or copy, by the pre- and post-image paths in that order.
    for (let i = 0; i < tokens.length; i += 1) {
      const letter = tokens[i]?.[0];
      if (letter == null) continue;
      const status = letterStatus(letter);
      const oldPath = status === "renamed" ? tokens[++i] : undefined;
      const path = tokens[++i];
      if (path == null || path.length === 0) continue;
      const count = counts.get(path);
      files.push({
        path,
        status,
        ...(oldPath != null && oldPath.length > 0 ? { oldPath } : {}),
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        binary: count?.binary ?? false,
      });
    }

    for (const path of splitNul(others?.stdout ?? "")) {
      if (path.length === 0) continue;
      const { additions, binary } = await untrackedCounts(repoPath, path);
      files.push({ path, status: "untracked", additions, deletions: 0, binary });
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { repoPath, branch, files };
  }

  async function changes(repoPath: string, base?: DiffBase): Promise<ChangesSnapshot> {
    await assertRepo(repoPath);
    return changesWith(repoPath, await diffPair(repoPath, base));
  }

  /** The branch alone, for a repo no task has claimed yet — the 空状态 row asks this. */
  async function branch(repoPath: string): Promise<string | null> {
    await assertRepo(repoPath);
    return currentBranch(repoPath);
  }

  /** Rejects anything that could escape the repo before it ever reaches git. */
  function checkPath(repoPath: string, raw: string): string {
    if (raw.length === 0) throw new BadRequestError("path 不能为空", "invalid_path");
    if (raw.includes("\0") || raw.includes("\\")) throw new BadRequestError(`非法的 path: ${raw}`, "invalid_path");
    if (isAbsolute(raw) || raw.startsWith("/")) throw new BadRequestError(`path 必须是仓库相对路径: ${raw}`, "invalid_path");
    for (const segment of raw.split("/")) {
      if (segment.length === 0 || segment === "." || segment === "..") throw new BadRequestError(`非法的 path: ${raw}`, "invalid_path");
    }
    const root = resolve(repoPath);
    const absolute = resolve(root, raw);
    if (absolute !== root && !absolute.startsWith(root + sep)) throw new BadRequestError(`path 超出仓库范围: ${raw}`, "invalid_path");
    return raw;
  }

  /** Validates, then pins the path to an entry of the current snapshot — with the baseline it was taken against. */
  async function resolveEntry(repoPath: string, raw: string, base?: DiffBase): Promise<{ entry: ChangedFile; pair: DiffPair }> {
    const path = checkPath(repoPath, raw);
    await assertRepo(repoPath);
    const pair = await diffPair(repoPath, base);
    const snapshot = await changesWith(repoPath, pair);
    const entry = snapshot.files.find((file) => file.path === path || file.oldPath === path);
    if (entry == null) throw new NotFoundError(`文件没有变更: ${path}`, "file_not_changed");
    return { entry, pair };
  }

  /** Cuts at the last newline that fits, so a truncated diff never ends mid-line. */
  function truncate(diff: string): { diff: string; truncated: boolean } {
    const buffer = Buffer.from(diff, "utf8");
    if (buffer.length <= maxDiffBytes) return { diff, truncated: false };
    const head = buffer.subarray(0, maxDiffBytes);
    const lastNewline = head.lastIndexOf(0x0a);
    // A single line longer than the budget has no boundary to cut on.
    return { diff: head.subarray(0, lastNewline >= 0 ? lastNewline + 1 : head.length).toString("utf8"), truncated: true };
  }

  async function fileDiff(repoPath: string, rawPath: string, base?: DiffBase): Promise<FileDiff> {
    const { entry, pair } = await resolveEntry(repoPath, rawPath, base);
    const head = { path: entry.path, status: entry.status, ...(entry.oldPath != null ? { oldPath: entry.oldPath } : {}) };
    if (entry.binary) return { ...head, binary: true, diff: "", truncated: false };

    let text: string;
    if (entry.status === "untracked") {
      // `--no-index` reports "differences found" as exit 1; only >= 2 is a failure.
      const result = await run(repoPath, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", entry.path], [1]);
      text = result.stdout;
    } else {
      const paths = entry.oldPath != null ? [entry.oldPath, entry.path] : [entry.path];
      const result = await run(repoPath, ["diff", ...revs(pair), "--no-color", "--no-ext-diff", "-M", "--", ...paths]);
      text = result.stdout;
    }
    return { ...head, binary: false, ...truncate(text) };
  }

  /** Puts one file back the way the baseline had it — deleting it when it was not there at all. */
  async function revert(repoPath: string, rawPath: string, base?: DiffBase): Promise<{ path: string }> {
    const { entry, pair } = await resolveEntry(repoPath, rawPath, base);
    // A snapshot baseline belongs to a task running in the user's own checkout,
    // where the index is the user's: the file is written straight to the working
    // tree and nothing is ever staged or unstaged on the way. `git checkout
    // <base> -- <path>` would do both.
    const ownIndex = pair.tree != null;
    const restore = (path: string) =>
      ownIndex
        ? run(repoPath, ["restore", "--source", pair.base, "--worktree", "--", path])
        : run(repoPath, ["checkout", pair.base, "--", path]);
    const unstage = async (path: string) => {
      if (ownIndex) return;
      if (await isInIndex(repoPath, path)) await run(repoPath, ["rm", "-q", "--cached", "--force", "--", path]);
    };

    if (entry.status === "renamed" && entry.oldPath != null) {
      await unstage(entry.path);
      await rm(resolve(repoPath, entry.path), { force: true });
      await restore(entry.oldPath);
      return { path: entry.oldPath };
    }

    if (entry.status === "added" || entry.status === "untracked") {
      await unstage(entry.path);
      // Directories the file lived in are left alone: they may hold other work.
      await rm(resolve(repoPath, entry.path), { force: true });
      return { path: entry.path };
    }

    await restore(entry.path);
    return { path: entry.path };
  }

  return { branch, changes, fileDiff, revert };
}
