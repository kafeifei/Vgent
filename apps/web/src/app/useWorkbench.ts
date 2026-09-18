import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/api";
import { ThreadChats } from "@/lib/threadChats";
import { useServerState } from "@/lib/useServerState";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, ThreadMessageMetadata, ThreadSummary, WorkspaceMode } from "@/lib/types";
import { LIVE_STATUSES } from "@/lib/types";
import { repoRelative } from "@/features/changes/paths";
import { useChanges } from "@/features/changes/useChanges";
import type { Grouping } from "@/features/sidebar/grouping";
import type { RightTab } from "@/features/rightpane/RightPane";

export type LeftMode = "on" | "rail";
export type View = "thread" | "empty";

/** The right column: which tab, and which changed file that tab has open. */
export interface RightState {
  open: boolean;
  tab: RightTab;
  file: string | null;
}

const RIGHT_CLOSED: RightState = { open: false, tab: "queue", file: null };

const readThreadFromUrl = (): string | null => new URLSearchParams(window.location.search).get("thread");

function writeThreadToUrl(threadId: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (threadId == null) params.delete("thread");
  else params.set("thread", threadId);
  const query = params.toString();
  window.history.replaceState(null, "", query === "" ? window.location.pathname : `?${query}`);
}

export const isLiveThread = (thread: ThreadSummary | undefined): boolean =>
  thread != null && (LIVE_STATUSES as readonly string[]).includes(thread.status);

/**
 * All of the workbench's state in one hook: the server snapshot, the per-thread
 * `Chat` registry, which thread and panels are open, and the actions the shell
 * hands down. Components get state plus one `actions` object.
 */
export function useWorkbench(token: string) {
  const toast = useToast();
  const client = useMemo(() => createClient(token), [token]);
  const state = useServerState(token);

  const chats = useMemo(() => new ThreadChats(token, (error) => toast(error.message)), [token, toast]);
  useEffect(() => () => chats.dispose(), [chats]);
  useEffect(() => chats.observeThreads(state.threads), [chats, state.threads]);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readThreadFromUrl());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (readThreadFromUrl() == null ? "empty" : "thread"));
  const [left, setLeft] = useState<LeftMode>("on");
  const [right, setRight] = useState<RightState>(RIGHT_CLOSED);
  const [palette, setPalette] = useState(false);
  const [grouping, setGrouping] = useState<Grouping>("project");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * 引擎能力表, loaded once. Everything the UI shows per engine — its name, the
   * 「只能全自动」 note, whether 压缩上下文 is on offer — is read from here, so no
   * component ever compares an engine id to a literal.
   */
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  useEffect(() => {
    let cancelled = false;
    void client.listEngines().then(
      (list) => {
        if (!cancelled) setEngines(list);
      },
      (error: Error) => toast(error.message),
    );
    return () => {
      cancelled = true;
    };
  }, [client, toast]);

  const thread = state.threads.find((entry) => entry.id === selectedThreadId);
  // A selected thread always wins over the manual project pick.
  const activeProjectId = thread?.projectId ?? projectId ?? state.projects[0]?.id ?? null;

  /** The 变更 tab's selection, from the panel's own file rows. */
  const selectChange = useCallback((file: string | null) => setRight((state) => ({ ...state, file })), []);

  /**
   * The selected task's working-tree snapshot. Loaded here, not inside
   * `RightPane`, because the composer's 审查 pill needs the same numbers whether
   * or not the right column is open — one hook feeding both is also what keeps
   * it to a single fetch per `updatedAt`.
   */
  const changes = useChanges({
    client,
    threadId: selectedThreadId,
    refreshKey: thread?.updatedAt ?? "",
    selected: right.file,
    onSelect: selectChange,
    toast,
  });

  const selectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId);
    writeThreadToUrl(threadId);
    setView(threadId == null ? "empty" : "thread");
    setSettingsOpen(false);
  }, []);

  /**
   * A selected thread the server dropped falls back to the empty state — but
   * only once we have actually seen it in a snapshot. A thread created a
   * moment ago is not in the latest snapshot yet, and deselecting it there
   * would throw the user back to the empty state right after they started it.
   */
  const knownThreadIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!state.connected) return;
    const ids = new Set(state.threads.map((entry) => entry.id));
    const vanished = selectedThreadId != null && knownThreadIds.current.has(selectedThreadId) && !ids.has(selectedThreadId);
    knownThreadIds.current = ids;
    if (vanished && selectedThreadId != null) {
      chats.forget(selectedThreadId);
      selectThread(null);
    }
  }, [chats, selectThread, selectedThreadId, state.connected, state.threads]);

  const actions = useMemo(
    () => ({
      selectThread,
      selectProject: (id: string) => setProjectId(id),
      newTask: () => {
        setView("empty");
        setSelectedThreadId(null);
        writeThreadToUrl(null);
      },
      setGrouping,
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
      toggleLeft: () => setLeft((mode) => (mode === "on" ? "rail" : "on")),
      toggleRight: () => setRight((state) => ({ ...state, open: !state.open })),
      openRight: () => setRight((state) => ({ ...state, open: true })),
      setRightTab: (tab: RightTab) => setRight((state) => ({ ...state, tab })),
      selectChange,

      /**
       * A file chip in the work log. The engines report absolute paths and the
       * changes API takes repo-relative ones, so the project's `repoPath` is
       * what turns the one into the other.
       */
      openChanges: (file?: string) => {
        // A worktree task's engine writes inside its own checkout, so that is
        // the root the chip's absolute path is relative to.
        const repoPath =
          thread?.workspace?.path ?? state.projects.find((project) => project.id === activeProjectId)?.repoPath ?? null;
        const relative = file == null || repoPath == null ? null : repoRelative(file, repoPath);
        setRight({ open: true, tab: "changes", file: relative });
        if (file != null && relative == null) toast("文件不在任务工作目录内");
      },

      openPalette: () => setPalette(true),
      closePalette: () => setPalette(false),

      addProject: async (repoPath: string) => {
        const project = await client.createProject(repoPath);
        if (project.note != null) toast(project.note);
        setProjectId(project.id);
      },

      /** Native folder chooser: the desktop shell's own dialog, or the server's. */
      pickFolder: () => client.pickFolder(),

      /** Empty state: create the thread, select it, send the first message. */
      startThread: (
        text: string,
        engine: EngineId,
        workspace: WorkspaceMode,
        model: string | null,
        reasoningEffort: string | null,
      ) => {
        if (activeProjectId == null) {
          toast("先添加一个项目");
          return;
        }
        void client
          .createThread({
            projectId: activeProjectId,
            engine,
            workspace,
            // Omitted, not null: the server reads「没传」as「用 defaultModel」.
            ...(model == null ? {} : { model }),
            ...(reasoningEffort == null ? {} : { reasoningEffort }),
          })
          .then(async (record) => {
            selectThread(record.id);
            await chats.send(record.id, text);
          })
          .catch((error: Error) => toast(error.message));
      },

      send: (threadId: string, text: string) => {
        void chats.send(threadId, text).catch((error: Error) => toast(error.message));
      },

      stop: (threadId: string) => {
        void chats.stop(threadId);
      },

      rename: (threadId: string, title: string) => {
        void client.patchThread(threadId, { title }).catch((error: Error) => toast(error.message));
      },

      /**
       * 选模型即选引擎: the two travel together, in one PATCH. The server refuses
       * the engine half on a thread that already has messages.
       */
      setModel: (threadId: string, engine: EngineId, model: string | undefined) => {
        void client.patchThread(threadId, { engine, model: model ?? null }).catch((error: Error) => toast(error.message));
      },

      setReasoningEffort: (threadId: string, reasoningEffort: string | null) => {
        void client.patchThread(threadId, { reasoningEffort }).catch((error: Error) => toast(error.message));
      },

      /** 「一直允许」: one more tool on the *global* allowlist, from an approval card. */
      allowTool: (toolName: string) => {
        void client.allowTool(toolName).catch((error: Error) => toast(error.message));
      },

      // 归档 also reclaims the task's worktree, and un-archiving restores it —
      // the server does both in one PATCH, so one failure means neither moved.
      archiveThread: (threadId: string, archived: boolean) => {
        void client.patchThread(threadId, { archived }).then(
          () => toast(archived ? "已归档，worktree 已回收" : "已取消归档"),
          (error: Error) => toast(error.message),
        );
      },

      deleteThread: (threadId: string) => {
        void client.deleteThread(threadId).then(
          () => {
            chats.forget(threadId);
            if (threadId === selectedThreadId) selectThread(null);
            toast("已删除任务");
          },
          (error: Error) => toast(error.message),
        );
      },

      // Reclaim snapshots the worktree before removing it, so both directions
      // are recoverable and neither asks for a confirmation.
      reclaimWorkspace: (threadId: string): Promise<void> =>
        client.reclaimWorkspace(threadId).then(
          () => toast("已回收，快照已保存"),
          (error: Error) => toast(error.message),
        ),

      restoreWorkspace: (threadId: string): Promise<void> =>
        client.restoreWorkspace(threadId).then(
          () => toast("已恢复"),
          (error: Error) => toast(error.message),
        ),

      // The chat itself needs no nudge: the record's `updatedAt` moves, and
      // `ThreadChats.refreshIfStale` re-fetches the (now two-message) history.
      compactThread: (threadId: string): Promise<void> =>
        client.compactThread(threadId).then(
          (record) => {
            const before = (record.messages[0]?.metadata as ThreadMessageMetadata | undefined)?.compacted?.before;
            toast(`已压缩：${before ?? record.messages.length} 条消息 → 摘要`);
          },
          (error: Error) => toast(error.message),
        ),

      getChat: (threadId: string) => chats.get(threadId),
      whenReady: (threadId: string) => chats.whenReady(threadId),
      toast,
    }),
    [activeProjectId, chats, client, selectChange, selectThread, selectedThreadId, state.projects, state.threads, thread, toast],
  );

  // ⌘K / ⌘N / ⌘J / ⌘B
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      } else if (key === "n") {
        event.preventDefault();
        actions.newTask();
      } else if (key === "j") {
        event.preventDefault();
        setRight((state) => ({ ...state, open: !state.open }));
      } else if (key === "b") {
        event.preventDefault();
        setLeft((mode) => (mode === "on" ? "rail" : "on"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions]);

  return {
    state,
    client,
    engines,
    thread,
    changes,
    selectedThreadId,
    activeProjectId,
    view,
    left,
    right,
    palette,
    grouping,
    settingsOpen,
    actions,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
export type WorkbenchActions = Workbench["actions"];
