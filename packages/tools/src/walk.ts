/** Shared file-walking helpers for `grep` and `glob`, built on Node 22's `fs.promises.glob`. */
import { glob as fsGlob } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// A function-valued `exclude` is only honored by fs.promises.glob's recursive (`**`) walk path;
// non-magic/single-level patterns like `*` skip the callback entirely and yield everything,
// leaking node_modules/.git into shallow listings. Glob-pattern strings are honored on both
// paths, so use those instead, anchored with `**/` to also match nested occurrences.
const EXCLUDE_PATTERNS = ["**/node_modules", "**/.git"];

export interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

/**
 * `fs.promises.glob` matches an absolute pattern (`/Users/x/.ssh/*`) or one that
 * climbs out with `..` wherever it points, ignoring `cwd`. The search root was
 * already validated by the caller; the pattern must not take the walk out of it.
 */
function assertPatternInsideRoot(pattern: string): void {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error(`Pattern ${JSON.stringify(pattern)} must be relative to the search directory and must not contain "..".`);
  }
}

/** True when `target` is `root` itself or lies below it (lexically; resolve symlinks first when they matter). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Yields absolute paths (files and directories) under `root` matching `pattern`, skipping `.git` and `node_modules`. */
export async function* walkEntries(root: string, pattern = "**/*"): AsyncGenerator<WalkEntry> {
  assertPatternInsideRoot(pattern);
  for await (const entry of fsGlob(pattern, { cwd: root, withFileTypes: true, exclude: EXCLUDE_PATTERNS })) {
    const path = join(entry.parentPath, entry.name);
    // Backstop for spellings the syntactic check cannot see, e.g. `{..,x}/*`.
    if (!isInside(root, path)) continue;
    yield { path, isDirectory: entry.isDirectory() };
  }
}

/** Yields absolute file paths under `root` matching `pattern`, skipping `.git` and `node_modules`. */
export async function* walkFiles(root: string, pattern = "**/*"): AsyncGenerator<string> {
  for await (const entry of walkEntries(root, pattern)) {
    if (!entry.isDirectory) yield entry.path;
  }
}
