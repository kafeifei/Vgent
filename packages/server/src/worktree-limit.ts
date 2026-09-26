/**
 * The cap on live worktrees.
 *
 * Every worktree is a full checkout plus whatever its setup installed, so a
 * month of tasks is tens of gigabytes nobody asked for. Over the cap, the
 * oldest tasks that are not mid-turn give their directory back — through the
 * ordinary reclaim, which keeps their changes in git first, so 「恢复工作目录」
 * brings them back and reruns the setup for the rest.
 */
import type { ProjectStore } from "./store/projects.js";
import type { ThreadStore } from "./store/threads.js";
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
  log?: Logger;
}

/** Reclaims oldest-first until the number of live worktrees is within the cap. */
export async function enforceWorktreeLimit(options: EnforceWorktreeLimitOptions): Promise<number> {
  const { dataDir, threads, projects, max } = options;
  const log = options.log ?? silentLogger;

  const summaries = await threads.list();
  const live = summaries.filter((summary) => summary.workspace != null && summary.workspace.reclaimed !== true);
  let count = live.length;
  if (count <= max) return 0;

  const candidates = live
    // 归档中 is reclaiming it already.
    .filter((summary) => !LIVE.includes(summary.status) && summary.transition == null)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

  let reclaimed = 0;
  for (const candidate of candidates) {
    if (count <= max) break;
    const thread = await threads.get(candidate.id);
    if (thread?.workspace == null || thread.workspace.reclaimed === true || thread.transition != null) continue;
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
      log.warn(`回收 worktree 失败: ${thread.title}`, error);
    }
  }
  return reclaimed;
}
