/**
 * Path safety for the built-in coding tools.
 *
 * `resolveToolPath` is ported from `../freecode/server/tools.ts`'s
 * `resolveToolPath` (lines ~37-64): it resolves a tool-supplied path against
 * the working directory, walks up to the closest existing ancestor and takes
 * its `realpath` before rejoining the missing suffix, and rejects anything
 * that lands outside the working directory — including escapes via a
 * symlinked ancestor — unless `allowOutsideWorkDir` is set. Dangling symlinks
 * are rejected rather than treated as "missing".
 *
 * This walk only makes sense against a real filesystem (it needs `lstat` /
 * `realpath`), so it backs the node:fs-based `FileSystemLike` implementation.
 * The sandbox-backed implementation uses `resolveWorkspacePath` instead: a
 * sandbox session exposes no `lstat`/`realpath`, and its filesystem is
 * already isolated from the host, so a syntactic containment check is the
 * right amount of safety there.
 */
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ResolvePathOptions {
  /** Allow the resolved path to land outside `workDir`. Defaults to false. */
  allowOutsideWorkDir?: boolean;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * True when `target` lies inside a `.git` entry below `root`: a repository's
 * `.git` directory, or the `.git` file a linked worktree has instead. Whatever
 * is written there decides which programs git runs (`config`'s `core.fsmonitor`,
 * `hooks/*`), so a file tool has no business changing it. Both paths have to be
 * canonical (symlinks resolved) for the answer to mean anything.
 */
export function isInsideGitMetadata(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return rel.split(sep).some(isGitName);
}

/** `.git`, however the filesystem is willing to spell it (see `foldFileName`). */
const isGitName = (segment: string): boolean => foldFileName(segment) === ".git";

/**
 * One path segment in a form where every spelling a filesystem treats as the
 * same name compares equal. macOS volumes are case-insensitive by default, and
 * the case folding is Unicode's, not ASCII's: APFS takes `ſ` for `s`, the
 * Kelvin sign for `k`, `ß` and `ẞ` for `ss`, `ﬅ` for `st`. Both APFS and HFS+
 * ignore NFC vs NFD, and HFS+ also ignores zero-width code points inside a
 * name. NFKC folds wider still (fullwidth `ｇ` becomes `g`, which no volume
 * does), on purpose: this only decides what a guard refuses or asks about, and
 * a name folded in by mistake costs one question where one left out is a bypass.
 */
export const foldFileName = (segment: string): string =>
  segment
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .normalize("NFKC")
    // Lower, upper, lower: `ẞ` only lowers to `ß`, and only upper-casing makes that `ss`.
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Resolve `input` against `workDir` without touching the filesystem beyond
 * normalizing the path. Used for sandbox-backed file operations, where the
 * session's filesystem is not the host's and there is no `lstat`/`realpath`
 * to walk with.
 */
export function resolveWorkspacePath(workDir: string, input: string, options: ResolvePathOptions = {}): string {
  if (!input || input.includes("\0")) throw new Error(`Invalid file path: ${JSON.stringify(input)}`);
  const target = resolve(workDir, expandHome(input));
  if (!options.allowOutsideWorkDir && !within(workDir, target)) {
    throw new Error(`Path "${input}" resolves outside the working directory.`);
  }
  return target;
}

/**
 * Resolve `input` against `workDir` on the real filesystem, defeating symlink
 * escapes: walk up to the closest existing ancestor, take its `realpath`, and
 * rejoin the missing suffix onto that canonical ancestor before checking
 * containment. Call again after any operation that could let the filesystem
 * change underneath you (e.g. after an approval wait, or after `mkdir`).
 *
 * Rejects:
 * - paths that escape `workDir` via `..` segments,
 * - paths that escape `workDir` via a symlinked ancestor,
 * - dangling symlinks (a symlink whose target does not exist).
 */
export async function resolveToolPath(workDir: string, input: string, options: ResolvePathOptions = {}): Promise<string> {
  if (!input || input.includes("\0")) throw new Error(`Invalid file path: ${JSON.stringify(input)}`);
  const root = await realpath(workDir);
  const requested = resolve(root, expandHome(input));

  let probe = requested;
  const missing: string[] = [];
  for (;;) {
    try {
      const info = await lstat(probe);
      const canonical = await realpath(probe); // A dangling symlink fails here (ENOENT).
      if (missing.length > 0 && !info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`Path "${input}" has a non-directory component in the middle of the path.`);
      }
      const target = resolve(canonical, ...missing);
      if (!options.allowOutsideWorkDir && !within(root, target)) {
        throw new Error(`Path "${input}" resolves outside the working directory (including symlink escapes).`);
      }
      return target;
    } catch (error) {
      if (!isErrnoException(error, "ENOENT")) throw error;
      // A dangling symlink must not be treated as an ordinary missing path.
      const link = await lstat(probe).catch(() => null);
      if (link?.isSymbolicLink()) throw new Error(`Path "${input}" contains a dangling symlink.`);
      const parent = dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(relative(parent, probe));
      probe = parent;
    }
  }
}
