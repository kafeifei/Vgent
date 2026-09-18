import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/api";
import { ThreadChats } from "@/lib/threadChats";
import { useServerState } from "@/lib/useServerState";
import { useToast } from "@/lib/toast";
import type { EngineId, PermissionMode, ThreadSummary, WorkspaceMode } from "@/lib/types";
import { LIVE_STATUSES } from "@/lib/types";
import { repoRelative } from "@/features/changes/paths";
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

  const thread = state.threads.find((entry) => entry.id === selectedThreadId);
  // A selected thread always wins over the manual project pick.
  const activeProjectId = thread?.projectId ?? projectId ?? state.projects[0]?.id ?? null;

  const selectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId);
    writeThreadToUrl(threadId);
    setView(threadId == null ? "empty" : "thread");
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
      toggleLeft: () => setLeft((mode) => (mode === "on" ? "rail" : "on")),
      toggleRight: () => setRight((state) => ({ ...state, open: !state.open })),
      openRight: () => setRight((state) => ({ ...state, open: true })),
      setRightTab: (tab: RightTab) => setRight((state) => ({ ...state, tab })),
      /** The 变更 tab's selection, from the panel's own file rows. */
      selectChange: (file: string | null) => setRight((state) => ({ ...state, file })),

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
        setProjectId(project.id);
      },

      /** Native folder chooser, run by the server so desktop and browser share it. */
      pickFolder: () => client.pickFolder(),

      /** Empty state: create the thread, select it, send the first message. */
      startThread: (text: string, engine: EngineId, workspace: WorkspaceMode, model: string | null) => {
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
            ...(engine === "codex" ? { permissionMode: "allow-all" as const } : {}),
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

      setModel: (threadId: string, model: string | null) => {
        void client.patchThread(threadId, { model }).catch((error: Error) => toast(error.message));
      },

      setEngine: (threadId: string, engine: EngineId) => {
        void client
          .patchThread(threadId, {
            engine,
            ...(engine === "codex" ? { permissionMode: "allow-all" as const } : {}),
          })
          .catch((error: Error) => toast(error.message));
      },

      setPermission: (threadId: string, permissionMode: PermissionMode) => {
        void client.patchThread(threadId, { permissionMode }).catch((error: Error) => toast(error.message));
      },

      getChat: (threadId: string) => chats.get(threadId),
      whenReady: (threadId: string) => chats.whenReady(threadId),
      toast,
    }),
    [activeProjectId, chats, client, selectThread, state.projects, thread, toast],
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
    thread,
    selectedThreadId,
    activeProjectId,
    view,
    left,
    right,
    palette,
    grouping,
    actions,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
export type WorkbenchActions = Workbench["actions"];
