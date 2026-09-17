/** Shared file-walking helpers for `grep` and `glob`, built on Node 22's `fs.promises.glob`. */
import type { Dirent } from "node:fs";
import { glob as fsGlob } from "node:fs/promises";
import { join } from "node:path";

export function isExcludedDirent(entry: Dirent): boolean {
  return entry.name === ".git" || entry.name === "node_modules";
}

/** Yields absolute file paths under `root` matching `pattern`, skipping `.git` and `node_modules`. */
export async function* walkFiles(root: string, pattern = "**/*"): AsyncGenerator<string> {
  for await (const entry of fsGlob(pattern, { cwd: root, withFileTypes: true, exclude: isExcludedDirent })) {
    if (entry.isDirectory()) continue;
    yield join(entry.parentPath, entry.name);
  }
}
