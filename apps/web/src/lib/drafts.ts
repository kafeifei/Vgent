/**
 * 草稿任何情况下不丢: what is half-typed in the composer, per task, in
 * `localStorage`.
 *
 * The composer is remounted on every thread switch (`key={thread.id}`) and
 * wiped by a reload, so React state alone loses it both ways. The store is
 * keyed by thread id — `vgent.draft.new` for the empty state, which has no task
 * yet — and every access is wrapped, exactly like `prefs.ts`: private mode
 * throws on the very first read, and a lost draft must never take the app down
 * with it.
 */

const PREFIX = "vgent.draft.";

/** The empty state's own draft; it becomes a real task's first message. */
export const NEW_TASK_DRAFT = "new";

const keyOf = (threadId: string): string => `${PREFIX}${threadId}`;

export function readDraft(threadId: string): string {
  try {
    return localStorage.getItem(keyOf(threadId)) ?? "";
  } catch {
    return "";
  }
}

/** Blank clears the entry rather than storing an empty string. */
export function writeDraft(threadId: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(keyOf(threadId));
    else localStorage.setItem(keyOf(threadId), value);
  } catch {
    /* private mode, or the quota is full: the in-memory draft still works */
  }
}

export function clearDraft(threadId: string): void {
  writeDraft(threadId, "");
}

/**
 * Drop the drafts of tasks that no longer exist. Called with every `/api/state`
 * snapshot, because a task deleted in another window is the one case nothing
 * else would ever clean up after.
 */
export function pruneDrafts(liveThreadIds: Iterable<string>): void {
  const keep = new Set([...liveThreadIds].map(keyOf));
  keep.add(keyOf(NEW_TASK_DRAFT));
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key != null && key.startsWith(PREFIX) && !keep.has(key)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
