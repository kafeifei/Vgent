import type { ThreadSummary, ThreadTransition } from "@/lib/types";
import { isArchived } from "./grouping";

/**
 * 归档 / 取消归档 the user just clicked, by thread: `true` is on its way into
 * 已归档, `false` on its way out. Held only until the server's snapshot shows
 * the task on the same side — from then on its own `transition` says whether
 * the worktree is still catching up.
 */
export type PendingArchive = ReadonlyMap<string, boolean>;

/** The `transition` the server will set for this move: only a worktree has anything to take apart or put back. */
export function expectedTransition(thread: ThreadSummary, archived: boolean): ThreadTransition | undefined {
  const workspace = thread.workspace;
  if (archived) return workspace != null && workspace.reclaimed !== true ? "archiving" : undefined;
  return workspace?.reclaimed === true && workspace.snapshotPath != null ? "unarchiving" : undefined;
}

/** The snapshot as it will be once the server has taken the click in: the row moves the moment it is clicked. */
export function withPendingArchive(threads: ThreadSummary[], pending: PendingArchive): ThreadSummary[] {
  if (pending.size === 0) return threads;
  return threads.map((thread) => {
    const archived = pending.get(thread.id);
    if (archived == null || isArchived(thread) === archived) return thread;
    const transition = expectedTransition(thread, archived);
    const { archivedAt: _archivedAt, transition: _transition, ...rest } = thread;
    return {
      ...rest,
      ...(archived ? { archivedAt: new Date().toISOString() } : {}),
      ...(transition != null ? { transition } : {}),
    };
  });
}

/** Moves the server has caught up with — or whose task is gone — drop out. The same map when nothing did. */
export function settledPendingArchive(pending: PendingArchive, threads: readonly ThreadSummary[]): PendingArchive {
  if (pending.size === 0) return pending;
  const next = new Map(pending);
  for (const [id, archived] of pending) {
    const thread = threads.find((entry) => entry.id === id);
    if (thread == null || isArchived(thread) === archived) next.delete(id);
  }
  return next.size === pending.size ? pending : next;
}
