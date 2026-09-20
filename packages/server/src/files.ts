/**
 * The 「文件」panel's and the composer's `@` completion data source: the
 * working tree of one directory, as git sees it.
 *
 * Tracked plus untracked files with `.gitignore` honoured, minus the ones that
 * are only in the index — i.e. exactly what is on disk and worth referencing.
 * Directories are derived from the paths; git never lists them itself.
 */
import { execFile } from "node:child_process";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { BadRequestError, GitError, GitUnavailableError, NotAGitRepoError, NotFoundError } from "./errors.js";

export interface FileEntry {
  /** Repo-relative, `/` separated; a directory carries no trailing slash. */
  path: string;
  kind: "file" | "dir";
}

export interface FileListing {
  root: string;
  entries: FileEntry[];
  /** More entries matched than the answer carries. */
  truncated: boolean;
}

export interface FileContent {
  path: string;
  /** Empty for a binary file. */
  content: string;
  truncated: boolean;
  binary: boolean;
}

/** A file's own bytes, for the previews that show it as what it is — a picture, not text. */
export interface FileBytes {
  /** Root-relative, `/` separated. */
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

/** A path as a tool or a reply wrote it, and the root-relative file it names. */
export interface ResolvedFile {
  raw: string;
  path: string;
}

export interface ListFilesOptions {
  /** Fuzzy query; absent means「列出全部」. */
  q?: string;
  /** Only with `q`. Defaults to 50, capped at 200. */
  limit?: number;
}

export interface Files {
  list(root: string, options?: ListFilesOptions): Promise<FileListing>;
  content(root: string, path: string): Promise<FileContent>;
  /** The whole file. `path` may be absolute, as models like to write it; it still has to sit inside `root`. */
  bytes(root: string, path: string): Promise<FileBytes>;
  /** Of the given paths, the ones that name a file inside `root` that is there right now. */
  resolve(root: string, paths: readonly string[]): Promise<ResolvedFile[]>;
}

export interface CreateFilesOptions {
  /** Per-git-invocation timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_STDERR_CHARS = 500;
/** Cap on an unfiltered listing: the tree is for browsing, not for mirroring. */
const MAX_ENTRIES = 5000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Cap on one file's text. */
const MAX_CONTENT_BYTES = 512 * 1024;
/** How much of a file we sniff for NUL bytes. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Cap on a file served whole: a preview, not a download. */
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
/** Cap on one `resolve` request. */
const MAX_RESOLVE_PATHS = 200;
/** Directories a plain walk never enters; git would have ignored them. */
const WALK_SKIPPED = new Set([".git", "node_modules"]);

/** What the previews can show. Anything else is served as opaque bytes. */
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

interface ExecError extends Error {
  code?: number | string;
  killed?: boolean;
}

/** Drops the trailing empty field every `-z` record list ends with. */
function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `a/b/c.ts` → `a/b/c.ts`'s trailing segment. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

/** Whether every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/** Lower is better; `-1` is「不匹配」. Both arguments are already lower-cased. */
function rank(path: string, query: string): number {
  const name = baseName(path).toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  return isSubsequence(query, path.toLowerCase()) ? 2 : -1;
}

/** Every unique ancestor prefix of the given files, as `dir` entries. */
function deriveDirs(paths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    let slash = path.indexOf("/");
    while (slash > 0) {
      dirs.add(path.slice(0, slash));
      slash = path.indexOf("/", slash + 1);
    }
  }
  return dirs;
}

export function createFiles(options: CreateFilesOptions = {}): Files {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

  /** Runs git in `root`; exit 128 means「不是仓库」, everything else throws. */
  async function run(root: string, args: string[]): Promise<string> {
    const settled = await new Promise<{ error: ExecError | null; stdout: string; stderr: string }>((done) => {
      execFile("git", args, { cwd: root, timeout, maxBuffer: MAX_BUFFER, encoding: "utf8", env }, (error, stdout, stderr) =>
        done({ error: error as ExecError | null, stdout, stderr }),
      );
    });
    const { error, stdout, stderr } = settled;
    if (error == null) return stdout;
    if (error.code === "ENOENT") throw new GitUnavailableError();
    if (error.killed === true) throw new GitError(`git 超时（${timeout}ms）: git ${args.join(" ")}`);
    if (error.code === 128) throw new NotAGitRepoError(`不是 git 仓库: ${root}`);
    throw new GitError(`git ${args.join(" ")} 失败: ${stderr.trim().slice(0, MAX_STDERR_CHARS) || error.message}`);
  }

  /** Every path on disk git knows about, ignored files excluded. */
  async function paths(root: string): Promise<string[]> {
    const [listed, deleted] = await Promise.all([
      run(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      run(root, ["ls-files", "-z", "--deleted"]),
    ]);
    // Staged-then-removed files are still `--cached`; nothing can read them.
    const gone = new Set(splitNul(deleted));
    return [...new Set(splitNul(listed))].filter((path) => path.length > 0 && !gone.has(path));
  }

  /**
   * The same listing without git: a 无项目 task runs in a directory that is no
   * repository, and its files are still its files.
   */
  async function walk(root: string): Promise<string[]> {
    const found: string[] = [];
    const visit = async (dir: string, prefix: string): Promise<void> => {
      const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const child of children) {
        if (found.length > MAX_ENTRIES) return;
        const path = prefix === "" ? child.name : `${prefix}/${child.name}`;
        if (child.isDirectory()) {
          if (!WALK_SKIPPED.has(child.name)) await visit(resolve(dir, child.name), path);
        } else if (child.isFile()) {
          found.push(path);
        }
      }
    };
    await visit(root, "");
    return found;
  }

  async function list(root: string, listOptions: ListFilesOptions = {}): Promise<FileListing> {
    const files = await paths(root).catch((error: unknown) => {
      if (error instanceof NotAGitRepoError) return walk(root);
      throw error;
    });
    const entries: FileEntry[] = [
      ...files.map((path): FileEntry => ({ path, kind: "file" })),
      ...[...deriveDirs(files)].map((path): FileEntry => ({ path, kind: "dir" })),
    ];

    const query = listOptions.q?.trim().toLowerCase() ?? "";
    if (query.length === 0) {
      entries.sort((a, b) => compare(a.path, b.path));
      return { root, entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
    }

    const limit = Math.min(Math.max(Math.trunc(listOptions.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const ranked = entries
      .map((entry) => ({ entry, score: rank(entry.path, query) }))
      .filter((scored) => scored.score >= 0)
      // Same rank: the shallower, shorter path is the likelier target.
      .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || compare(a.entry.path, b.entry.path));
    return { root, entries: ranked.slice(0, limit).map((scored) => scored.entry), truncated: ranked.length > limit };
  }

  /** Rejects anything that could escape `root` before it ever touches the disk. */
  function checkPath(raw: string): string {
    if (raw.length === 0) throw new BadRequestError("path 不能为空", "invalid_path");
    if (raw.includes("\0") || raw.includes("\\")) throw new BadRequestError(`非法的 path: ${raw}`, "invalid_path");
    if (isAbsolute(raw) || raw.startsWith("/")) throw new BadRequestError(`path 必须是仓库相对路径: ${raw}`, "invalid_path");
    for (const segment of raw.split("/")) {
      if (segment.length === 0 || segment === "." || segment === "..") throw new BadRequestError(`非法的 path: ${raw}`, "invalid_path");
    }
    return raw;
  }

  /**
   * The file on disk a path names. A symlink pointing out of the repo passes
   * any textual check, so the resolved path is what actually decides.
   */
  async function locate(root: string, path: string): Promise<{ target: string; base: string }> {
    const base = await realpath(resolve(root));
    const target = await realpath(resolve(base, path)).catch(() => null);
    if (target == null) throw new NotFoundError(`文件不存在: ${path}`, "file_not_found");
    if (target !== base && !target.startsWith(base + sep)) throw new BadRequestError(`path 超出仓库范围: ${path}`, "invalid_path");
    if (!(await stat(target)).isFile()) throw new NotFoundError(`不是普通文件: ${path}`, "file_not_found");
    return { target, base };
  }

  /**
   * A path as a model writes it — absolute as often as not — down to the
   * root-relative one. Being inside `root` is still `locate`'s call.
   */
  async function locateLoose(root: string, raw: string): Promise<{ target: string; path: string }> {
    if (raw.length === 0) throw new BadRequestError("path 不能为空", "invalid_path");
    if (raw.includes("\0")) throw new BadRequestError(`非法的 path: ${raw}`, "invalid_path");
    const { target, base } = await locate(root, isAbsolute(raw) ? raw : checkPath(raw.replace(/^\.\//, "")));
    return { target, path: relative(base, target).split(sep).join("/") };
  }

  async function bytes(root: string, raw: string): Promise<FileBytes> {
    const { target, path } = await locateLoose(root, raw);
    if ((await stat(target)).size > MAX_PREVIEW_BYTES) throw new BadRequestError(`文件太大，无法预览: ${path}`, "file_too_large");
    return { path, mediaType: mediaTypeOf(path), bytes: await readFile(target) };
  }

  async function resolveAll(root: string, raws: readonly string[]): Promise<ResolvedFile[]> {
    const found = await Promise.all(
      raws.slice(0, MAX_RESOLVE_PATHS).map((raw) =>
        locateLoose(root, raw).then(
          ({ path }): ResolvedFile => ({ raw, path }),
          () => null,
        ),
      ),
    );
    return found.filter((entry): entry is ResolvedFile => entry != null);
  }

  async function content(root: string, raw: string): Promise<FileContent> {
    const path = checkPath(raw);
    const { target } = await locate(root, path);

    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(MAX_CONTENT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_CONTENT_BYTES, 0);
      const head = buffer.subarray(0, bytesRead);
      if (head.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { path, content: "", truncated: false, binary: true };
      const truncated = bytesRead === MAX_CONTENT_BYTES && (await handle.stat()).size > MAX_CONTENT_BYTES;
      // Cutting on a newline keeps the tail from ending mid-character.
      const lastNewline = truncated ? head.lastIndexOf(0x0a) : -1;
      const text = lastNewline >= 0 ? head.subarray(0, lastNewline + 1) : head;
      return { path, content: text.toString("utf8"), truncated, binary: false };
    } finally {
      await handle.close();
    }
  }

  return { list, content, bytes, resolve: resolveAll };
}
