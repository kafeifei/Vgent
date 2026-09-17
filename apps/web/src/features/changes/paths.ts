import type { ChangedFile } from "@/lib/types";

/** `a/b/c.ts` → `a/b`; a file at the repo root → `""`. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export interface DirGroup {
  dir: string;
  files: ChangedFile[];
}

/** Groups the snapshot's files by directory, keeping the server's order. */
export function groupByDir(files: readonly ChangedFile[]): DirGroup[] {
  const groups: DirGroup[] = [];
  for (const file of files) {
    const dir = dirName(file.path);
    const last = groups.at(-1);
    if (last?.dir === dir) last.files.push(file);
    else groups.push({ dir, files: [file] });
  }
  return groups;
}

/**
 * A tool's file argument → the repo-relative POSIX path the changes API takes.
 *
 * Claude Code hands out absolute paths; the engines may hand out relative ones.
 * A path outside the repo has no repo-relative form, and gives `null`.
 */
export function repoRelative(file: string, repoPath: string): string | null {
  const path = file.replace(/\\/g, "/");
  const root = repoPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path === "") return null;
  if (!path.startsWith("/")) return path;
  if (root === "") return null;
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}
