import { useCallback, useState } from "react";
import type { FileEntry } from "@/lib/types";

/** Up to this many entries, the tree opens fully — collapsing would hide everything. */
export const EXPAND_ALL_MAX = 8;

/** Which directories start open: all of them in a small listing, none in a large one. */
export function initialExpansion(entries: readonly FileEntry[]): Set<string> {
  return entries.length <= EXPAND_ALL_MAX
    ? new Set(entries.filter((entry) => entry.kind === "dir").map((entry) => entry.path))
    : new Set();
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Which directories of a task's file tree are open.
 *
 * The listing is fetched again every time the task writes (its `updatedAt`
 * moves), and only the *first* listing of a task decides what starts open —
 * every later one is the same tree with newer contents, and must leave the
 * user's open and closed folders where they put them. Another task starts from
 * its own first listing.
 */
export function useTreeExpansion(threadId: string | null): {
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  /** Called with each listing that arrives. */
  settle: (entries: readonly FileEntry[]) => void;
} {
  const [held, setHeld] = useState<{ threadId: string | null; open: ReadonlySet<string> } | null>(null);
  const expanded = held != null && held.threadId === threadId ? held.open : NONE;

  const settle = useCallback(
    (entries: readonly FileEntry[]) =>
      setHeld((current) => (current != null && current.threadId === threadId ? current : { threadId, open: initialExpansion(entries) })),
    [threadId],
  );

  const toggle = useCallback(
    (path: string) =>
      setHeld((current) => {
        const open = new Set(current != null && current.threadId === threadId ? current.open : []);
        if (!open.delete(path)) open.add(path);
        return { threadId, open };
      }),
    [threadId],
  );

  return { expanded, toggle, settle };
}
