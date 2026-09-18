/**
 * The 「变更」panel's data source: one repo's working tree against a baseline.
 *
 * The baseline is HEAD for a task that edits the project directly, and the
 * worktree's `baseCommit` for a task with its own checkout — so everything the
 * task did counts, its own commits included. Staged and unstaged changes are
 * merged (`git diff <base>` compares the baseline straight to the working tree,
 * which is exactly that), plus untracked files with `.gitignore` honoured.
 * Everything shells out to the real `git`; no libgit, no cache.
 */
import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
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

export interface FileDiff {
  path: string;
  status: ChangeStatus;
  oldPath?: string;
  binary: boolean;
  /** Unified diff as git prints it; empty for binary files. */
  diff: string;
  truncated: boolean;
}

export interface Git {
  /** `base` defaults to HEAD, or the empty tree in a repo with no commit yet. */
  changes(repoPath: string, base?: string): Promise<ChangesSnapshot>;
  fileDiff(repoPath: string, path: string, base?: string): Promise<FileDiff>;
  revert(repoPath: string, path: string, base?: string): Promise<{ path: string }>;
}

export interface CreateGitOptions {
  /** Per-git-invocation timeout. */
  timeoutMs?: number;
  /** Cut-off for a single file's diff text. */
  maxDiffBytes?: number;
}

/** `git hash-object -t tree /dev/null` — the diff base when HEAD is unborn. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

  /** The caller's baseline, or `HEAD` — the empty tree when the repo has no commit yet. */
  async function diffBase(repoPath: string, base?: string): Promise<string> {
    if (base != null) return base;
    const head = await run(repoPath, ["rev-parse", "--quiet", "--verify", "HEAD"], [1]);
    return head.code === 0 && head.stdout.trim().length > 0 ? "HEAD" : EMPTY_TREE;
  }

  async function currentBranch(repoPath: string): Promise<string | null> {
    const result = await run(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"], [1]);
    const name = result.stdout.trim();
    return result.code === 0 && name.length > 0 ? name : null;
  }

  async function isInIndex(repoPath: string, path: string): Promise<boolean> {
    const result = await run(repoPath, ["ls-files", "--error-unmatch", "-z", "--", path], [1]);
    return result.code === 0;
  }

  /** `path` → `[additions, deletions, binary]` for everything tracked, keyed by the post-image path. */
  async function numstat(repoPath: string, base: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
    const result = await run(repoPath, ["diff", base, "--numstat", "-z", "-M", "--no-color"]);
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

  async function changes(repoPath: string, base?: string): Promise<ChangesSnapshot> {
    await assertRepo(repoPath);
    const resolved = await diffBase(repoPath, base);
    const [branch, counts, nameStatus, others] = await Promise.all([
      currentBranch(repoPath),
      numstat(repoPath, resolved),
      run(repoPath, ["diff", resolved, "--name-status", "-z", "-M", "--no-color"]),
      run(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
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

    for (const path of splitNul(others.stdout)) {
      if (path.length === 0) continue;
      const { additions, binary } = await untrackedCounts(repoPath, path);
      files.push({ path, status: "untracked", additions, deletions: 0, binary });
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { repoPath, branch, files };
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

  /** Validates, then pins the path to an entry of the current snapshot. */
  async function resolveEntry(repoPath: string, raw: string, base?: string): Promise<ChangedFile> {
    const path = checkPath(repoPath, raw);
    const snapshot = await changes(repoPath, base);
    const entry = snapshot.files.find((file) => file.path === path || file.oldPath === path);
    if (entry == null) throw new NotFoundError(`文件没有变更: ${path}`, "file_not_changed");
    return entry;
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

  async function fileDiff(repoPath: string, rawPath: string, base?: string): Promise<FileDiff> {
    const entry = await resolveEntry(repoPath, rawPath, base);
    const head = { path: entry.path, status: entry.status, ...(entry.oldPath != null ? { oldPath: entry.oldPath } : {}) };
    if (entry.binary) return { ...head, binary: true, diff: "", truncated: false };

    let text: string;
    if (entry.status === "untracked") {
      // `--no-index` reports "differences found" as exit 1; only >= 2 is a failure.
      const result = await run(repoPath, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", entry.path], [1]);
      text = result.stdout;
    } else {
      const paths = entry.oldPath != null ? [entry.oldPath, entry.path] : [entry.path];
      const result = await run(repoPath, ["diff", await diffBase(repoPath, base), "--no-color", "--no-ext-diff", "-M", "--", ...paths]);
      text = result.stdout;
    }
    return { ...head, binary: false, ...truncate(text) };
  }

  /** Puts one file back the way the baseline had it — deleting it when it was not there at all. */
  async function revert(repoPath: string, rawPath: string, base?: string): Promise<{ path: string }> {
    const entry = await resolveEntry(repoPath, rawPath, base);
    const resolved = await diffBase(repoPath, base);

    if (entry.status === "renamed" && entry.oldPath != null) {
      if (await isInIndex(repoPath, entry.path)) await run(repoPath, ["rm", "-q", "--cached", "--force", "--", entry.path]);
      await rm(resolve(repoPath, entry.path), { force: true });
      await run(repoPath, ["checkout", resolved, "--", entry.oldPath]);
      return { path: entry.oldPath };
    }

    if (entry.status === "added" || entry.status === "untracked") {
      if (await isInIndex(repoPath, entry.path)) await run(repoPath, ["rm", "-q", "--cached", "--force", "--", entry.path]);
      // Directories the file lived in are left alone: they may hold other work.
      await rm(resolve(repoPath, entry.path), { force: true });
      return { path: entry.path };
    }

    await run(repoPath, ["checkout", resolved, "--", entry.path]);
    return { path: entry.path };
  }

  return { changes, fileDiff, revert };
}
