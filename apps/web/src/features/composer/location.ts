import { isNoProject } from "@/lib/noProject";
import type { ChangesSnapshot, ThreadSummary } from "@/lib/types";

/**
 * What the row under the composer says about *where* a task runs. Both answers
 * come from the task itself first and from its 变更快照 only as a fallback, so
 * the row is filled in before any diff has been fetched — and stays filled in
 * for a task whose snapshot cannot be taken at all (a reclaimed worktree, a
 * project that is not a git repo).
 */

/** 分支: a worktree task's own branch, otherwise the branch its checkout is on. */
export function taskBranch(thread: ThreadSummary, snapshot: ChangesSnapshot | null): string | null {
  return thread.workspaceState != null ? null : (thread.workspace?.branch ?? snapshot?.branch ?? null);
}

/** 运行位置, spelled out, with the real directory for the tooltip. */
export function taskLocation(
  thread: ThreadSummary,
  snapshot: ChangesSnapshot | null,
): { label: string; path: string | null } {
  const workspace = thread.workspace;
  if (thread.workspaceState != null) return { label: "本机 · worktree", path: null };
  if (workspace != null) {
    return {
      // 已回收 belongs here rather than in a tooltip: the directory named right
      // next to it does not exist any more.
      label: workspace.reclaimed === true ? "本机 · worktree（已回收）" : "本机 · worktree",
      path: workspace.path,
    };
  }
  // 无项目: not a checkout of anything — the task's own directory, which goes when the task does.
  if (isNoProject(thread.projectId)) return { label: "本机 · 临时目录", path: null };
  return { label: "本机 · 主目录", path: snapshot?.repoPath ?? null };
}
