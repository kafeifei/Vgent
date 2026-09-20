/**
 * 无项目: a task that belongs to no project. It still needs somewhere to run —
 * every engine takes a working directory — so it gets one of its own under the
 * data dir, empty and not a git repo. Everything that is about a *repository*
 * (branch, changes, checkpoints, worktrees, 收口) finds nothing to work with
 * there and stays out of the way, which is the point: this is for asking and
 * for throwaway work, not for a codebase.
 *
 * One id for all such tasks, so the sidebar can file them under one heading;
 * the directory is per task, so two of them never see each other's files.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectStore } from "./store/projects.js";
import type { Project } from "./types.js";

export const NO_PROJECT_ID = "no-project";
export const NO_PROJECT_NAME = "无项目";

export const isNoProject = (projectId: string): boolean => projectId === NO_PROJECT_ID;

/** The task's own directory. Removed with the task. */
export const scratchDirOf = (dataDir: string, threadId: string): string => join(dataDir, "scratch", threadId);

/**
 * The project a task runs in: the stored one, or — for a 无项目 task — a
 * stand-in whose `repoPath` is the task's scratch directory, created on the way.
 */
export async function projectOfThread(
  projects: Pick<ProjectStore, "get">,
  dataDir: string,
  thread: { id: string; projectId: string; createdAt?: string },
): Promise<Project | undefined> {
  if (!isNoProject(thread.projectId)) return projects.get(thread.projectId);
  const repoPath = scratchDirOf(dataDir, thread.id);
  await mkdir(repoPath, { recursive: true });
  return { id: NO_PROJECT_ID, name: NO_PROJECT_NAME, repoPath, createdAt: thread.createdAt ?? new Date(0).toISOString() };
}
