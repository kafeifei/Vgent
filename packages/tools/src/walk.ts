/** Shared file-walking helpers for `grep` and `glob`, built on Node 22's `fs.promises.glob`. */
import { glob as fsGlob } from "node:fs/promises";
import { join } from "node:path";

// A function-valued `exclude` is only honored by fs.promises.glob's recursive (`**`) walk path;
// non-magic/single-level patterns like `*` skip the callback entirely and yield everything,
// leaking node_modules/.git into shallow listings. Glob-pattern strings are honored on both
// paths, so use those instead, anchored with `**/` to also match nested occurrences.
const EXCLUDE_PATTERNS = ["**/node_modules", "**/.git"];

export interface WalkEntry {
  path: string;
  isDirectory: boolean;
}

/** Yields absolute paths (files and directories) under `root` matching `pattern`, skipping `.git` and `node_modules`. */
export async function* walkEntries(root: string, pattern = "**/*"): AsyncGenerator<WalkEntry> {
  for await (const entry of fsGlob(pattern, { cwd: root, withFileTypes: true, exclude: EXCLUDE_PATTERNS })) {
    yield { path: join(entry.parentPath, entry.name), isDirectory: entry.isDirectory() };
  }
}

/** Yields absolute file paths under `root` matching `pattern`, skipping `.git` and `node_modules`. */
export async function* walkFiles(root: string, pattern = "**/*"): AsyncGenerator<string> {
  for await (const entry of walkEntries(root, pattern)) {
    if (!entry.isDirectory) yield entry.path;
  }
}
