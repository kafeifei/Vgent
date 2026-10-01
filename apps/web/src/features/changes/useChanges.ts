import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ApiClient } from "@/lib/api";
import type {
  ApplyConflict,
  ChangesResponse,
  ChangesScope,
  FileDiff,
  IntegrateAction,
  IntegrateResponse,
  IntegrationStatus,
} from "@/lib/types";

export interface ChangesView {
  snapshot: ChangesResponse | null;
  loading: boolean;
  /** The snapshot call's message — "not a git repo" and friends land here. */
  error: string | null;
  refresh: () => void;
  /** 改动的范围: the whole task, or just its last turn. */
  scope: ChangesScope;
  setScope: (scope: ChangesScope) => void;
  /** Whether the task has a last turn worth its own scope; the toggle hides otherwise. */
  lastTurn: boolean;
  selected: string | null;
  select: (path: string | null) => void;
  fileDiff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  revert: (path: string) => void;
  /** 收口: what the action bar may offer, `null` until the first load lands. */
  integration: IntegrationStatus | null;
  /** True while one of the four actions is in flight. */
  integrating: boolean;
  /**
   * The last action's failure, shown inside the panel rather than only as a
   * toast: 带回主目录's conflict list is several lines long.
   */
  actionError: string | null;
  /**
   * What a refused 带回主目录 clashed on. Present only while that refusal is the
   * last thing that happened, which is exactly when 「带冲突标记合并」 is on
   * offer.
   */
  applyConflicts: ApplyConflict[] | null;
  dismissApplyConflicts: () => void;
  integrate: (action: IntegrateAction, input?: { message?: string; conflicts?: "markers" }) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The 409's payload, when the failure really is 带回主目录 telling us what clashed. */
function conflictsOf(error: unknown): ApplyConflict[] | null {
  if (!(error instanceof ApiError) || error.code !== "apply_conflict") return null;
  const list = (error.details as { conflicts?: unknown } | undefined)?.conflicts;
  return Array.isArray(list) && list.length > 0 ? (list as ApplyConflict[]) : null;
}

/**
 * State that belongs to one visit to a task. Read under another task's id it is
 * the empty value at once: an effect that cleared it would leave one render — and
 * one paint — showing the last task's 审查 numbers, branch and buttons under the
 * new task's name. The slot is emptied on the way, too, so coming back to a task
 * starts it clean (全部改动, no old error or conflict list) like the first visit
 * did. A late write from the old task is never seen, and takes nothing from the
 * task that is on screen.
 */
export function useTaskState<T>(threadId: string | null, empty: T): [T, (value: T) => void] {
  const [held, setHeld] = useState<{ threadId: string | null; value: T }>({ threadId, value: empty });
  // Adjusted during render rather than in an effect: React renders again at once,
  // before anything is committed, so no frame ever holds the old task's value.
  if (held.threadId !== threadId) setHeld({ threadId, value: empty });
  // The task on screen *now*, for a write that was started under another one.
  const current = useRef(threadId);
  current.current = threadId;
  const set = useCallback(
    (value: T) => {
      // There is one slot. A write that comes in late from the task that was left would take it
      // from the task that is on screen, and that task would read as empty.
      if (current.current !== threadId) return;
      setHeld({ threadId, value });
    },
    [threadId],
  );
  return [held.threadId === threadId ? held.value : empty, set];
}

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

  // Everything below that describes a task is that task's: another task starts
  // empty, on 全部改动 like every task does — not one effect later.
  const [snapshot, setSnapshot] = useTaskState<ChangesResponse | null>(threadId, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useTaskState<string | null>(threadId, null);
  /** Bumped per snapshot load; a stale response never writes state. */
  const generation = useRef(0);
  const [scope, setScope] = useTaskState<ChangesScope>(threadId, "all");
  /**
   * Kept out of `snapshot`: 「上一轮」 is still available while its own fetch is
   * in flight, and dropping the toggle mid-switch would take the way back with it.
   */
  const [lastTurn, setLastTurn] = useTaskState(threadId, false);

  /** Fetched alongside the snapshot: the action bar is part of the same view. */
  const [integration, setIntegration] = useTaskState<IntegrationStatus | null>(threadId, null);

  const load = useCallback(async (): Promise<ChangesResponse | null> => {
    const mine = ++generation.current;
    if (threadId == null) {
      setSnapshot(null);
      setIntegration(null);
      setError(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    // The two calls fail independently: a repo we cannot diff still has nothing
    // to offer, but an unavailable `gh` must not blank the file list.
    void client
      .getIntegration(threadId)
      .then((next) => {
        if (mine === generation.current) setIntegration(next);
      })
      .catch(() => {
        if (mine === generation.current) setIntegration(null);
      });
    try {
      const next = await client.listChanges(threadId, scope);
      if (mine !== generation.current) return null;
      setSnapshot(next);
      if (next.lastTurn != null) setLastTurn(next.lastTurn);
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
  }, [client, scope, setError, setIntegration, setLastTurn, setSnapshot, threadId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const [fileDiff, setFileDiff] = useTaskState<FileDiff | null>(threadId, null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useTaskState<string | null>(threadId, null);
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
      .getFileDiff(threadId, selected, scope)
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
  }, [changed, client, scope, setDiffError, setFileDiff, threadId, selected, snapshot]);

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

  const [integrating, setIntegrating] = useState(false);
  // They describe the last action on *this* task; another task starts clean.
  const [actionError, setActionError] = useTaskState<string | null>(threadId, null);
  const [applyConflicts, setApplyConflicts] = useTaskState<ApplyConflict[] | null>(threadId, null);

  const integrate = useCallback(
    (action: IntegrateAction, input?: { message?: string; conflicts?: "markers" }) => {
      if (threadId == null) return;
      setIntegrating(true);
      setActionError(null);
      setApplyConflicts(null);
      void (async () => {
        try {
          const record = await client.integrate(threadId, action, input);
          toast(record.note ?? describe(action, record));
          // The compare page (and a freshly created PR) is only useful if it
          // opens; the badge in the bar is the fallback when the browser says no.
          if (action === "pr" && record.pr != null) window.open(record.pr.url, "_blank", "noreferrer");
        } catch (failure) {
          setActionError(message(failure));
          setApplyConflicts(conflictsOf(failure));
        } finally {
          setIntegrating(false);
        }
        // Whatever happened, the tree may have moved: 提交 empties it, 丢弃
        // rewinds it, and a failed 带回 left it exactly as it was.
        await load();
      })();
    },
    [client, load, setActionError, setApplyConflicts, threadId, toast],
  );

  const dismissApplyConflicts = useCallback(() => setApplyConflicts(null), [setApplyConflicts]);

  // One object for as long as nothing in it changed: it goes to the composer,
  // the right pane and the log, and they are memoised on it.
  return useMemo(
    () => ({
      snapshot,
      loading,
      error,
      refresh,
      scope,
      setScope,
      lastTurn,
      selected,
      select: onSelect,
      fileDiff,
      diffLoading,
      diffError,
      revert,
      integration,
      integrating,
      actionError,
      applyConflicts,
      dismissApplyConflicts,
      integrate,
    }),
    [
      snapshot, loading, error, refresh, scope, setScope, lastTurn, selected, onSelect, fileDiff, diffLoading, diffError,
      revert, integration, integrating, actionError, applyConflicts, dismissApplyConflicts, integrate,
    ],
  );
}

/** The one line the toast says. Everything in it comes from what the server did, not from what we asked for. */
function describe(action: IntegrateAction, record: IntegrateResponse): string {
  if (action === "commit") {
    const ref = record.outcome?.ref;
    return `已提交${ref != null ? ` ${ref.slice(0, 7)}` : ""}`;
  }
  if (action === "pr") return record.pr?.kind === "compare" ? "已推送分支，去 GitHub 开 PR" : "已开 PR";
  if (action === "discard") return "已全部丢弃";
  if (action === "apply") {
    const marked = record.apply?.conflicts.filter((entry) => entry.resolution === "markers").length ?? 0;
    const skipped = record.apply?.conflicts.filter((entry) => entry.resolution === "skipped").length ?? 0;
    if (marked === 0 && skipped === 0) return "已带回主目录";
    const parts = [marked > 0 ? `${marked} 个带冲突标记` : "", skipped > 0 ? `${skipped} 个跳过` : ""].filter((part) => part !== "");
    return `已带回主目录，${parts.join("，")}`;
  }
  const kept = record.undo?.kept.length ?? 0;
  return kept > 0 ? `已撤销带回，${kept} 个你改过的文件保持原样` : "已撤销带回";
}
