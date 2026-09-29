/**
 * The cap on live worktrees.
 *
 * Every worktree is a full checkout plus whatever its setup installed, so a
 * month of tasks is tens of gigabytes nobody asked for. Over the cap, the
 * oldest clean tasks that are not mid-turn give their directory back — through
 * the ordinary reclaim, and 「恢复工作目录」 reruns the setup for them. A task
 * with uncommitted changes is never reclaimed behind the user's back: that
 * takes their confirmation, which only 归档 / 回收 asks for (as Fumie's disk
 * budget reclaims clean checkouts only).
 */
import type { ProjectStore } from "./store/projects.js";
import type { ThreadStore } from "./store/threads.js";
import { ConflictError } from "./errors.js";
import type { Logger, ThreadStatus } from "./types.js";
import { silentLogger } from "./types.js";
import { reclaimWorktree } from "./workspace.js";

export const DEFAULT_WORKTREE_MAX_COUNT = 25;

/** A task whose turn is still alive keeps its files, whatever its age. */
const LIVE: readonly ThreadStatus[] = ["running", "awaiting-approval", "awaiting-input"];

export interface EnforceWorktreeLimitOptions {
  dataDir: string;
  threads: ThreadStore;
  projects: ProjectStore;
  /** `settings.worktreeMaxCount`, already defaulted. */
  max: number;
  /** A task just made or restored: skipping the dirty ones must not land on it. */
  keep?: string;
  log?: Logger;
}

/** Reclaims clean worktrees oldest-first until the number of live ones is within the cap. */
export async function enforceWorktreeLimit(options: EnforceWorktreeLimitOptions): Promise<number> {
  const { dataDir, threads, projects, max } = options;
  const log = options.log ?? silentLogger;

  const summaries = await threads.list();
  const live = summaries.filter((summary) => summary.workspace != null && summary.workspace.reclaimed !== true);
  let count = live.length;
  if (count <= max) return 0;

  const candidates = live
    // 归档中 is reclaiming it already.
    .filter((summary) => !LIVE.includes(summary.status) && summary.restartRecovery == null && summary.transition == null && summary.id !== options.keep)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  let reclaimed = 0;
  for (const candidate of candidates) {
    if (count <= max) break;
    const thread = await threads.get(candidate.id);
    if (thread?.workspace == null || thread.workspace.reclaimed === true || thread.transition != null ||
      LIVE.includes(thread.status) || thread.restartRecovery != null) continue;
    // A 无项目 task never has a worktree, so the stored projects are all there is to look in.
    const project = await projects.get(thread.projectId);
    if (project == null) continue;
    try {
      const { snapshotPath } = await reclaimWorktree({ dataDir, project, thread });
      await threads.update(thread.id, { workspace: { ...thread.workspace, reclaimed: true, snapshotPath } });
      log.info(`worktree 超过上限 ${max}，已回收 ${thread.title}`);
      count -= 1;
      reclaimed += 1;
    } catch (error) {
      if (error instanceof ConflictError && error.code === "archive_needs_confirmation") log.info(`worktree 有没提交的改动，不自动回收: ${thread.title}`);
      else log.warn(`回收 worktree 失败: ${thread.title}`, error);
    }
  }
  return reclaimed;
}
