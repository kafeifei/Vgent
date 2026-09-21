import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { createClient } from "@/lib/api";
import { pruneDrafts } from "@/lib/drafts";
import { ThreadChats } from "@/lib/threadChats";
import { useServerState } from "@/lib/useServerState";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, ThreadMessageMetadata, ThreadMode, ThreadStatus, ThreadSummary, WorkspaceMode } from "@/lib/types";
import { LIVE_STATUSES } from "@/lib/types";
import { repoRelative } from "@/features/changes/paths";
import { useChanges } from "@/features/changes/useChanges";
import { notificationsEnabled, pendingApprovalLabel } from "@/features/notify/notify";
import { useNotifications } from "@/features/notify/useNotifications";
import type { Grouping } from "@/features/sidebar/grouping";
import type { RightTab } from "@/features/rightpane/RightPane";

export type LeftMode = "on" | "off";
export type View = "thread" | "empty";

/** The right column: which tab, and which changed file that tab has open. */
export interface RightState {
  open: boolean;
  tab: RightTab;
  file: string | null;
  /**
   * The file the 文件 tab was asked to show, as whoever asked wrote it — a
   * reply's `![](…)`, an output card. `nonce` makes asking twice for the same
   * file open it twice.
   */
  preview: PreviewRequest | null;
}

export interface PreviewRequest {
  path: string;
  nonce: number;
}

/** The pane starts as Cursor's does: open, as the short list of what it can show. */
const RIGHT_INITIAL: RightState = { open: true, tab: "home", file: null, preview: null };

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
  // 草稿 of a task that no longer exists — deleted here or in another window —
  // is the one thing nothing else would ever clean up.
  useEffect(() => {
    if (state.connected) pruneDrafts(state.threads.map((entry) => entry.id));
  }, [state.connected, state.threads]);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readThreadFromUrl());
  const [projectId, setProjectId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (readThreadFromUrl() == null ? "empty" : "thread"));
  const [left, setLeft] = useState<LeftMode>("on");
  const [right, setRight] = useState<RightState>(RIGHT_INITIAL);
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

  /**
   * A task the user just marked 未读 by hand must not be read again by the
   * effect below while it is still the selected one. Switching away ends the
   * exemption, so coming back reads it like anything else.
   */
  const keepUnread = useRef<string | null>(null);

  const selectThread = useCallback((threadId: string | null) => {
    keepUnread.current = null;
    setSelectedThreadId(threadId);
    writeThreadToUrl(threadId);
    setView(threadId == null ? "empty" : "thread");
    setSettingsOpen(false);
  }, []);

  /**
   * 未读 clears when the task is really on screen: selected, in a window that is
   * visible and focused. A transition that lands while it is already open in a
   * focused window is therefore read straight away, and one that lands while the
   * window is in the background waits — which is what the sidebar dot and the
   * notification are for.
   */
  const unread = thread?.unread === true;
  useEffect(() => {
    if (selectedThreadId == null || !unread) return;
    let cleared = false;
    const clear = () => {
      if (cleared || document.hidden || !document.hasFocus()) return;
      if (keepUnread.current === selectedThreadId) return;
      cleared = true;
      // A failed clear is not worth interrupting anyone: the next focus event,
      // or the next snapshot, tries again.
      void client.patchThread(selectedThreadId, { unread: false }).catch(() => undefined);
    };
    clear();
    window.addEventListener("focus", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("focus", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [client, selectedThreadId, unread]);

  /** 等你审批 in a notification names what for, when this window has the chat. */
  const detailOf = useCallback((threadId: string) => pendingApprovalLabel(chats.peek(threadId)?.messages.at(-1)), [chats]);

  useNotifications({
    threads: state.threads,
    enabled: notificationsEnabled(state.settings),
    onSelect: selectThread,
    detailOf,
  });

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

  /**
   * A 计划 turn that just ended has produced a document nobody asked to see.
   * The right column opens on it once, on that transition — never again on a
   * re-render, so closing it stays closed.
   */
  const lastStatus = useRef<Map<string, ThreadStatus>>(new Map());
  useEffect(() => {
    for (const entry of state.threads) {
      const previous = lastStatus.current.get(entry.id);
      lastStatus.current.set(entry.id, entry.status);
      if (entry.id !== selectedThreadId || entry.mode !== "plan" || entry.status !== "idle") continue;
      if (previous == null || !(LIVE_STATUSES as readonly string[]).includes(previous)) continue;
      setRight((state) => ({ ...state, open: true, tab: "plan", file: null }));
    }
  }, [selectedThreadId, state.threads]);

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
      toggleLeft: () => setLeft((mode) => (mode === "on" ? "off" : "on")),
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
        setRight((state) => ({ ...state, open: true, tab: "changes", file: relative }));
        if (file != null && relative == null) toast("文件不在任务工作目录内");
      },

      /** A picture or a document the log points at: shown as what it is, in the 文件 tab. */
      openPreview: (path: string) =>
        setRight((state) => ({ ...state, open: true, tab: "files", preview: { path, nonce: (state.preview?.nonce ?? 0) + 1 } })),

      /** The 文件 tab took the request; a remount must not replay it. */
      clearPreview: () => setRight((state) => (state.preview == null ? state : { ...state, preview: null })),

      openPalette: () => setPalette(true),
      closePalette: () => setPalette(false),

      addProject: async (repoPath: string) => {
        const project = await client.createProject(repoPath);
        if (project.note != null) toast(project.note);
        setProjectId(project.id);
      },

      /** Native folder chooser: the desktop shell's own dialog, or the server's. */
      pickFolder: () => client.pickFolder(),

      /**
       * Empty state: create the thread, send the first message, open it.
       * Resolves `false` when the task could not even be created — the empty
       * state keeps its draft then. A task that exists but whose first message
       * the server refused keeps the text too, as *that task's* draft, so it
       * travels with the task the user is now looking at.
       */
      startThread: async (
        text: string,
        engine: EngineId,
        workspace: WorkspaceMode,
        model: string | null,
        reasoningEffort: string | null,
        mode: ThreadMode,
        files: FileUIPart[] = [],
        serviceTier: string | null = null,
        contextWindow: number | null = null,
      ): Promise<boolean> => {
        if (activeProjectId == null) {
          toast("先添加一个项目");
          return false;
        }
        const record = await client
          .createThread({
            projectId: activeProjectId,
            engine,
            workspace,
            // Omitted, not null: the server reads「没传」as「用 defaultModel」.
            ...(model == null ? {} : { model }),
            ...(reasoningEffort == null ? {} : { reasoningEffort }),
            ...(serviceTier == null ? {} : { serviceTier }),
            ...(contextWindow == null ? {} : { contextWindow }),
            mode,
          })
          .catch((error: Error) => {
            toast(error.message);
            return null;
          });
        if (record == null) return false;
        const accepted = await chats.send(record.id, text, files).then(
          () => true,
          () => false,
        );
        // Written before the task is opened, so its composer reads it on mount.
        if (!accepted) await client.putDraft(record.id, text).catch(() => undefined);
        selectThread(record.id);
        return true;
      },

      /** 分叉: the server builds the new task; all that is left is opening it. */
      forkThread: (threadId: string, messageId: string) => {
        void client.forkThread(threadId, messageId).then(
          (record) => selectThread(record.id),
          (error: Error) => toast(error.message),
        );
      },

      /**
       * Resolves `true` only once the server accepted the message. The composer
       * keeps the text until then, so a refused send never eats it; the error
       * itself is already toasted by the chat registry.
       */
      send: (threadId: string, text: string, files: FileUIPart[] = []): Promise<boolean> =>
        chats.send(threadId, text, files).then(
          () => true,
          () => false,
        ),

      /**
       * 运行中按 Enter：the message goes onto the task's queue on the *server*,
       * which starts it itself once the turn settles idle. Resolves `true` only
       * when it really landed — the composer keeps the draft otherwise.
       */
      queueMessage: (threadId: string, text: string): Promise<boolean> =>
        client.queueMessage(threadId, text).then(
          () => true,
          (error: Error) => {
            toast(error.message);
            return false;
          },
        ),

      editQueued: (threadId: string, itemId: string, text: string) => {
        void client.editQueued(threadId, itemId, text).catch((error: Error) => toast(error.message));
      },

      deleteQueued: (threadId: string, itemId: string) => {
        void client.deleteQueued(threadId, itemId).catch((error: Error) => toast(error.message));
      },

      /**
       * 「发送」 on a paused queue: run this one now instead of waiting. With
       * `interrupt` it is 「打断并发送」: the live turn is stopped first.
       */
      sendQueued: (threadId: string, itemId: string, options: { interrupt?: boolean } = {}) => {
        void client.sendQueued(threadId, itemId, options).catch((error: Error) => toast(error.message));
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

      /** 记住上次选择: the settings come back on the snapshot, so nothing is set here. */
      rememberModelEngine: (modelKey: string, engine: EngineId) => {
        void client.rememberModelEngine(modelKey, engine).catch((error: Error) => toast(error.message));
      },
      setContextWindow: (threadId: string, contextWindow: number | null) => {
        void client.patchThread(threadId, { contextWindow }).catch((error: Error) => toast(error.message));
      },
      setServiceTier: (threadId: string, serviceTier: string | null) => {
        void client.patchThread(threadId, { serviceTier }).catch((error: Error) => toast(error.message));
      },
      setReasoningEffort: (threadId: string, reasoningEffort: string | null) => {
        void client.patchThread(threadId, { reasoningEffort }).catch((error: Error) => toast(error.message));
      },

      /** 模式 of the next turn: Agent 直接动手, Plan 只读出计划. */
      setMode: (threadId: string, mode: ThreadMode) => {
        void client.patchThread(threadId, { mode }).catch((error: Error) => toast(error.message));
      },

      /**
       * Build: leave Plan mode and hand the document — the one on screen, not
       * the one the agent wrote — to an Agent turn, through the same send path
       * the composer uses.
       */
      buildFromPlan: (threadId: string, content: string): Promise<void> =>
        client
          .patchThread(threadId, { mode: "agent" })
          .then(() => chats.send(threadId, `按下面的计划执行。\n\n${content}`))
          .catch((error: Error) => toast(error.message)),

      /**
       * 「一直允许」: more entries on the *global* allowlist, from an approval
       * card. One POST each, chained — each one reads the stored list before it
       * writes, so firing them together would lose all but the last.
       */
      allowTools: (entries: readonly string[]) => {
        void entries
          .reduce((chain, entry) => chain.then(() => client.allowTool(entry)).then(() => {}), Promise.resolve())
          .catch((error: Error) => toast(error.message));
      },

      // 归档 also reclaims the task's worktree, and un-archiving restores it —
      // the server does both in one PATCH, so one failure means neither moved.
      archiveThread: (threadId: string, archived: boolean) => {
        void client.patchThread(threadId, { archived }).then(
          () => toast(archived ? "已归档，worktree 已回收" : "已取消归档"),
          (error: Error) => toast(error.message),
        );
      },

      /**
       * 标为未读 / 标为已读 from the sidebar row. Marking the selected task unread
       * sticks: the auto-clear above stands down until you switch away.
       */
      markUnread: (threadId: string, unread: boolean) => {
        keepUnread.current = unread ? threadId : null;
        void client.patchThread(threadId, { unread }).catch((error: Error) => toast(error.message));
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

  // ⌘K / ⌘N / ⌘J / ⌘B / ⌘,
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
        setLeft((mode) => (mode === "on" ? "off" : "on"));
      } else if (key === ",") {
        // The macOS convention for 设置; pressing it again goes back to the task.
        event.preventDefault();
        setSettingsOpen((open) => !open);
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
