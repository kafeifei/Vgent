/**
 * The 「变更」panel's data source: working tree vs HEAD for one repo.
 *
 * Staged and unstaged changes are merged — the engines write straight to disk
 * and we do not care about the index — plus untracked files (`.gitignore`
 * honoured). Everything shells out to the real `git`; no libgit, no cache.
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
  changes(repoPath: string): Promise<ChangesSnapshot>;
  fileDiff(repoPath: string, path: string): Promise<FileDiff>;
  revert(repoPath: string, path: string): Promise<{ path: string }>;
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

/** porcelain v2 `XY` → our merged (index + worktree vs HEAD) status. */
function mergeStatus(x: string, y: string): ChangeStatus | undefined {
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  // Staged as new, then deleted from the worktree: nothing left to show vs HEAD.
  if (x === "A" && y === "D") return undefined;
  if (x === "D" || y === "D") return "deleted";
  if (x === "A") return "added";
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

  /** `HEAD`, or the empty tree when the repo has no commit yet. */
  async function diffBase(repoPath: string): Promise<string> {
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
  async function numstat(repoPath: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
    const base = await diffBase(repoPath);
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

  async function changes(repoPath: string): Promise<ChangesSnapshot> {
    await assertRepo(repoPath);
    const [branch, counts, status] = await Promise.all([
      currentBranch(repoPath),
      numstat(repoPath),
      run(repoPath, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);

    const tokens = splitNul(status.stdout);
    const files: ChangedFile[] = [];
    const untracked: string[] = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token == null || token.length === 0) continue;
      const kind = token[0];
      if (kind === "?") {
        untracked.push(token.slice(2));
        continue;
      }
      if (kind !== "1" && kind !== "2" && kind !== "u") continue;
      const fields = token.split(" ");
      // `1`/`u` put the path at field 8, `2` at field 9 (after `<X><score>`).
      const pathFrom = kind === "2" ? 9 : kind === "u" ? 10 : 8;
      const path = fields.slice(pathFrom).join(" ");
      const oldPath = kind === "2" ? (tokens[++i] ?? "") : undefined;
      const xy = fields[1] ?? "..";
      const merged = kind === "u" ? "modified" : mergeStatus(xy[0] ?? ".", xy[1] ?? ".");
      if (merged == null || path.length === 0) continue;
      const count = counts.get(path);
      files.push({
        path,
        status: merged,
        ...(merged === "renamed" && oldPath != null && oldPath.length > 0 ? { oldPath } : {}),
        additions: count?.additions ?? 0,
        deletions: count?.deletions ?? 0,
        binary: count?.binary ?? false,
      });
    }

    for (const path of untracked) {
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
  async function resolveEntry(repoPath: string, raw: string): Promise<ChangedFile> {
    const path = checkPath(repoPath, raw);
    const snapshot = await changes(repoPath);
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

  async function fileDiff(repoPath: string, rawPath: string): Promise<FileDiff> {
    const entry = await resolveEntry(repoPath, rawPath);
    const base = { path: entry.path, status: entry.status, ...(entry.oldPath != null ? { oldPath: entry.oldPath } : {}) };
    if (entry.binary) return { ...base, binary: true, diff: "", truncated: false };

    let text: string;
    if (entry.status === "untracked") {
      // `--no-index` reports "differences found" as exit 1; only >= 2 is a failure.
      const result = await run(repoPath, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", entry.path], [1]);
      text = result.stdout;
    } else {
      const paths = entry.oldPath != null ? [entry.oldPath, entry.path] : [entry.path];
      const result = await run(repoPath, ["diff", await diffBase(repoPath), "--no-color", "--no-ext-diff", "-M", "--", ...paths]);
      text = result.stdout;
    }
    return { ...base, binary: false, ...truncate(text) };
  }

  async function revert(repoPath: string, rawPath: string): Promise<{ path: string }> {
    const entry = await resolveEntry(repoPath, rawPath);

    if (entry.status === "renamed" && entry.oldPath != null) {
      if (await isInIndex(repoPath, entry.path)) await run(repoPath, ["rm", "-q", "--cached", "--force", "--", entry.path]);
      await rm(resolve(repoPath, entry.path), { force: true });
      await run(repoPath, ["checkout", "HEAD", "--", entry.oldPath]);
      return { path: entry.oldPath };
    }

    if (entry.status === "added" || entry.status === "untracked") {
      if (await isInIndex(repoPath, entry.path)) await run(repoPath, ["rm", "-q", "--cached", "--force", "--", entry.path]);
      // Directories the file lived in are left alone: they may hold other work.
      await rm(resolve(repoPath, entry.path), { force: true });
      return { path: entry.path };
    }

    await run(repoPath, ["checkout", "HEAD", "--", entry.path]);
    return { path: entry.path };
  }

  return { changes, fileDiff, revert };
}
