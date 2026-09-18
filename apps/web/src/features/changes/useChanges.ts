import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/lib/api";
import type { ChangesSnapshot, FileDiff } from "@/lib/types";

export interface ChangesView {
  snapshot: ChangesSnapshot | null;
  loading: boolean;
  /** The snapshot call's message — "not a git repo" and friends land here. */
  error: string | null;
  refresh: () => void;
  selected: string | null;
  select: (path: string | null) => void;
  fileDiff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  revert: (path: string) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The 变更 tab's data: one working-tree snapshot for the selected task plus
 * the selected file's diff. The server resolves which directory that is — the
 * task's own worktree, or the project — so there is nothing to pick here.
 *
 * The selection itself lives in the workbench (the work log's file chips open
 * the pane on a file), so it comes in as `selected` / `onSelect` — this hook
 * only owns the two fetches.
 *
 * The snapshot is loaded whenever `refreshKey` — the thread's `updatedAt`,
 * which the server bumps as the engine writes — changes, regardless of whether
 * the right column is open: the composer's 审查 pill shows the same numbers
 * from a collapsed pane. The per-file diff stays lazy, since it is only fetched
 * once something has actually selected a file, which only opening the pane does.
 */
export function useChanges(options: {
  client: ApiClient;
  threadId: string | null;
  refreshKey: string;
  selected: string | null;
  onSelect: (path: string | null) => void;
  toast: (text: string) => void;
}): ChangesView {
  const { client, threadId, refreshKey, selected, onSelect, toast } = options;

  const [snapshot, setSnapshot] = useState<ChangesSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped per snapshot load; a stale response never writes state. */
  const generation = useRef(0);

  const load = useCallback(async (): Promise<ChangesSnapshot | null> => {
    const mine = ++generation.current;
    if (threadId == null) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const next = await client.listChanges(threadId);
      if (mine !== generation.current) return null;
      setSnapshot(next);
      setError(null);
      return next;
    } catch (failure) {
      if (mine !== generation.current) return null;
      setSnapshot(null);
      setError(message(failure));
      return null;
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, threadId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const diffGeneration = useRef(0);

  // Only a file the snapshot still lists has a diff to fetch; the panel says so
  // itself for one that does not, instead of us asking for a 404.
  const changed = snapshot?.files.some((file) => file.path === selected) ?? false;

  useEffect(() => {
    const mine = ++diffGeneration.current;
    if (threadId == null || selected == null || !changed) {
      setFileDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    setDiffLoading(true);
    client
      .getFileDiff(threadId, selected)
      .then((next) => {
        if (mine !== diffGeneration.current) return;
        setFileDiff(next);
        setDiffError(null);
      })
      .catch((failure: unknown) => {
        if (mine !== diffGeneration.current) return;
        setFileDiff(null);
        setDiffError(message(failure));
      })
      .finally(() => {
        if (mine === diffGeneration.current) setDiffLoading(false);
      });
    // `snapshot`: a refreshed snapshot means the engine wrote again, so the
    // open diff is stale too.
  }, [changed, client, threadId, selected, snapshot]);

  const refresh = useCallback(() => void load(), [load]);

  const revert = useCallback(
    (path: string) => {
      if (threadId == null) return;
      void (async () => {
        try {
          await client.revertFile(threadId, path);
          toast("已还原");
        } catch (failure) {
          toast(message(failure));
        }
        const next = await load();
        if (next != null && selected === path && !next.files.some((file) => file.path === path)) onSelect(null);
      })();
    },
    [client, load, onSelect, threadId, selected, toast],
  );

  return { snapshot, loading, error, refresh, selected, select: onSelect, fileDiff, diffLoading, diffError, revert };
}
