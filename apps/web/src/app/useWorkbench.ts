import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import type { OptionsSet } from "@/components/modelChoices";
import { isNoProject } from "@/lib/noProject";
import { createClient, isTurnStartCancelled, type ModelPickPatch } from "@/lib/api";
import { pruneDrafts } from "@/lib/drafts";
import { ThreadChats } from "@/lib/threadChats";
import { useServerState } from "@/lib/useServerState";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, Project, ThreadMode, ThreadStatus, ThreadSummary, WorkspaceMode } from "@/lib/types";
import { LIVE_STATUSES } from "@/lib/types";
import { repoRelative } from "@/features/changes/paths";
import { toFileParts, type Attachment } from "@/features/composer/attachments";
import { useChanges } from "@/features/changes/useChanges";
import { notificationsEnabled, pendingApprovalLabel } from "@/features/notify/notify";
import { useNotifications } from "@/features/notify/useNotifications";
import type { Grouping } from "@/features/sidebar/grouping";
import { settledPendingArchive, withPendingArchive, type PendingArchive } from "@/features/sidebar/pendingArchive";
import type { RightTab } from "@/features/rightpane/RightPane";
import { deleteTask } from "./deleteTask";

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
  /** The tool call a log row asked to see: 终端 scrolls to it, the detail view shows it. */
  inspect: InspectRequest | null;
  /** The 上下文已压缩 line asked to see: that marker's message id. */
  summary: string | null;
}

export interface InspectRequest {
  toolCallId: string;
  nonce: number;
}

export interface PreviewRequest {
  path: string;
  nonce: number;
}

/** The pane starts as Cursor's does: open, as the short list of what it can show. */
const RIGHT_INITIAL: RightState = { open: true, tab: "home", file: null, preview: null, inspect: null, summary: null };

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

/** 压缩中: no turn starts until the summary is written, so what is sent meanwhile queues. */
export const isCompacting = (thread: ThreadSummary | undefined): boolean => thread?.compaction != null && thread.compaction.error == null;

/**
 * All of the workbench's state in one hook: the server snapshot, the per-thread
 * `Chat` registry, which thread and panels are open, and the actions the shell
 * hands down. Components get state plus one `actions` object.
 */
export function useWorkbench(token: string) {
  const toast = useToast();
  const client = useMemo(() => createClient(token), [token]);
  const server = useServerState(token);
  /**
   * 归档 / 取消归档 moves the row on the click, not on the server's answer: the
   * worktree behind it can take a while, and the snapshot shows 归档中 / 恢复中
   * until it is done. Everything below reads the snapshot with these applied.
   */
  const [pendingArchive, setPendingArchive] = useState<PendingArchive>(() => new Map());
  useEffect(() => setPendingArchive((pending) => settledPendingArchive(pending, server.threads)), [server.threads]);
  // The create response can arrive before SSE. Show the opened workspace now,
  // then let the server snapshot take ownership as soon as it includes it.
  const [justAddedProject, setJustAddedProject] = useState<Project | null>(null);
  useEffect(() => {
    if (justAddedProject != null && server.projects.some((project) => project.id === justAddedProject.id)) setJustAddedProject(null);
  }, [justAddedProject, server.projects]);
  const state = useMemo(
    () => ({
      ...server,
      projects: justAddedProject != null && !server.projects.some((project) => project.id === justAddedProject.id)
        ? [...server.projects, justAddedProject] : server.projects,
      threads: pendingArchive.size === 0 ? server.threads : withPendingArchive(server.threads, pendingArchive),
    }),
    [justAddedProject, pendingArchive, server],
  );

  const chats = useMemo(() => new ThreadChats(token, (error) => toast(error.message)), [token, toast]);
  useEffect(() => () => chats.dispose(), [chats]);
  useEffect(() => chats.observeThreads(state.threads), [chats, state.threads]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => readThreadFromUrl());
  // The create response is already a durable task; paint it before the next SSE snapshot arrives.
  const [justCreated, setJustCreated] = useState<ThreadSummary | null>(null);
  const [failedFirstSend, setFailedFirstSend] = useState<string | null>(null);
  // 草稿 of a task that no longer exists — deleted here or in another window —
  // is the one thing nothing else would ever clean up.
  useEffect(() => {
    if (state.connected) pruneDrafts([...state.threads.map((entry) => entry.id), ...(justCreated == null ? [] : [justCreated.id])]);
  }, [justCreated, state.connected, state.threads]);
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

  const thread = state.threads.find((entry) => entry.id === selectedThreadId) ??
    (justCreated?.id === selectedThreadId ? justCreated : undefined);
  // A selected thread always wins over the manual project pick.
  const activeProjectId = thread?.projectId ?? projectId ?? state.projects[0]?.id ?? null;
  /**
   * What the callbacks in `actions` need to know at the moment they run. That
   * object is one for the life of the workbench — the sidebar, the composer and
   * the log are memoised on it — so it reads these through a ref rather than
   * closing over the render it was built in: a click sees the task list as it is
   * now, and an answer that arrives later sees the task that is on screen then.
   */
  const latest = useRef({ thread, threads: state.threads, projects: state.projects, activeProjectId, selectedThreadId });
  useLayoutEffect(() => {
    latest.current = { thread, threads: state.threads, projects: state.projects, activeProjectId, selectedThreadId };
  });
  // Opening a task is also picking its project: 新任务 from there starts in the
  // same one, not wherever the picker was left.
  const threadProjectId = thread?.projectId;
  useEffect(() => {
    if (threadProjectId != null) setProjectId(threadProjectId);
  }, [threadProjectId]);

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
    // 无项目 runs in a plain directory: no repo, so no 改动 and nothing to 收口 — and nothing to ask the server for.
    // Nor before the task list has arrived: until then a task opened from the URL is not known to be one.
    threadId: thread == null || isNoProject(thread.projectId) || thread.workspaceState != null ? null : selectedThreadId,
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

  // Opening a workspace is navigation. Clear the current task so its project
  // cannot override the chosen workspace, and reveal the workspace in the list.
  const openProject = useCallback((id: string) => {
    setProjectId(id);
    selectThread(null);
    setGrouping("project");
  }, [selectThread]);

  const addProject = useCallback(async (repoPath: string) => {
    const project = await client.createProject(repoPath);
    if (project.note != null) toast(project.note);
    setJustAddedProject(project);
    setProjectId(project.id);
  }, [client, toast]);

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
    if (justCreated != null && ids.has(justCreated.id)) setJustCreated(null);
    if (vanished && selectedThreadId != null) {
      chats.forget(selectedThreadId);
      selectThread(null);
    }
  }, [chats, justCreated, selectThread, selectedThreadId, state.connected, state.threads]);

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
      openProject,
      openFolder: async (repoPath: string) => {
        await addProject(repoPath);
        selectThread(null);
        setGrouping("project");
      },
      newTask: () => {
        // The model is not taken from the task being looked at: the empty state
        // starts from the last *started* choice, which the server keeps.
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
        const { thread, projects, activeProjectId } = latest.current;
        const repoPath = thread?.workspace?.path ?? projects.find((project) => project.id === activeProjectId)?.repoPath ?? null;
        const relative = file == null || repoPath == null ? null : repoRelative(file, repoPath);
        setRight((state) => ({ ...state, open: true, tab: "changes", file: relative }));
        if (file != null && relative == null) toast("文件不在任务工作目录内");
      },

      /** A picture or a document the log points at: shown as what it is, in the 文件 tab. */
      openPreview: (path: string) =>
        setRight((state) => ({ ...state, open: true, tab: "files", preview: { path, nonce: (state.preview?.nonce ?? 0) + 1 } })),

      /** A command row in the log: 终端, scrolled to that command. */
      focusTerminal: (toolCallId: string) =>
        setRight((state) => ({ ...state, open: true, tab: "term", inspect: { toolCallId, nonce: (state.inspect?.nonce ?? 0) + 1 } })),

      /** Any other tool row: the call's input and output, in full. */
      inspectTool: (toolCallId: string) =>
        setRight((state) => ({ ...state, open: true, tab: "tool", inspect: { toolCallId, nonce: (state.inspect?.nonce ?? 0) + 1 } })),

      /** 上下文已压缩: what the model reads in place of everything before that line. */
      openSummary: (messageId: string) => setRight((state) => ({ ...state, open: true, tab: "summary", summary: messageId })),

      /** The 文件 tab took the request; a remount must not replay it. */
      clearPreview: () => setRight((state) => (state.preview == null ? state : { ...state, preview: null })),

      openPalette: () => setPalette(true),
      closePalette: () => setPalette(false),

      addProject,

      /** Native folder chooser: the desktop shell's own dialog, or the server's. */
      pickFolder: () => client.pickFolder(),

      /**
       * Empty state: create the thread, open it immediately, then send the first message.
       * Resolves `false` when the task could not even be created — the empty
       * state keeps its draft then. A task that exists but whose first message
       * the server refused keeps the text and the files too, as *that task's*
       * draft, so they travel with the task the user is now looking at.
       */
      startThread: async (
        text: string,
        engine: EngineId,
        workspace: WorkspaceMode,
        model: string | null,
        reasoningEffort: string | null,
        mode: ThreadMode,
        attachments: readonly Attachment[] = [],
        serviceTier: string | null = null,
        contextWindow: number | null = null,
      ): Promise<boolean> => {
        const { activeProjectId } = latest.current;
        if (activeProjectId == null) {
          toast("先添加一个项目");
          return false;
        }
        const record = await client
          .createThread({
            projectId: activeProjectId,
            engine,
            workspace,
            ...(workspace === "worktree" ? { deferWorkspace: true } : {}),
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
        const { messages: _messages, applyUndo: _applyUndo, ...summary } = record;
        setJustCreated({ ...summary, messageCount: record.messages.length, pendingApprovals: 0 });
        selectThread(record.id);
        const accepted = await chats.send(record.id, text, toFileParts(attachments)).then(
          () => true,
          () => false,
        );
        // A rejected send still belongs to this task, even if the user has
        // switched away while its worktree was being created. A worktree that
        // could not be made keeps the message in the log itself (as Cursor
        // does), so then it is not put back into the composer as well.
        if (!accepted) {
          const kept = await client.getThread(record.id).then((thread) => thread.messages.length > 0, () => false);
          if (kept) return true;
          return client.putDraft(record.id, { text, attachments: [...attachments] }).then(
            () => { setFailedFirstSend(record.id); return true; },
            (error: Error) => { toast(error.message); return false; },
          );
        }
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

      /** Persist a steer or a next-turn item before clearing the composer. */
      queueMessage: (threadId: string, text: string, mode: "steer" | "queue" = "steer", files: FileUIPart[] = []): Promise<boolean> =>
        client.queueMessage(threadId, text, mode, files).then(
          () => true,
          (error: Error) => {
            toast(error.message);
            return false;
          },
        ),

      reorderQueue: (threadId: string, ids: readonly string[]) => {
        void client.reorderQueue(threadId, ids).catch((error: Error) => toast(error.message));
      },

      steerQueued: (threadId: string, itemId: string) => {
        void client.steerQueued(threadId, itemId).catch((error: Error) => toast(error.message));
      },

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
        // A stop that got there first leaves the message in the queue; nothing to report.
        return client.sendQueued(threadId, itemId, options).catch((error: Error) => {
          if (!isTurnStartCancelled(error)) toast(error.message);
        });
      },

      stop: (threadId: string) => {
        void chats.stop(threadId);
      },

      rename: (threadId: string, title: string) => {
        void client.patchThread(threadId, { title }).catch((error: Error) => toast(error.message));
      },

      /**
       * 选模型即选引擎: the two travel together, in one PATCH, and so do the
       * options the picker switched the task onto. The server refuses the
       * engine half on a thread that already has messages.
       */
      setModel: (threadId: string, engine: EngineId, model: string | undefined, options?: OptionsSet) => {
        void client.patchThread(threadId, { engine, model: model ?? null, ...options }).catch((error: Error) => toast(error.message));
      },

      /** 记住上次选择: the settings come back on the snapshot, so nothing is set here. */
      rememberModelPick: (modelKey: string, pick: ModelPickPatch) => {
        void client.rememberModelPick(modelKey, pick).catch((error: Error) => toast(error.message));
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
        // The server refuses the turn on an archived task, but only after the
        // mode switch went through — so it is turned away here, before either.
        latest.current.threads.find((entry) => entry.id === threadId)?.archivedAt != null
          ? Promise.resolve(toast("任务已归档，取消归档后才能继续"))
          : client
              .patchThread(threadId, { mode: "agent" })
              .then(() => chats.send(threadId, `按下面的计划执行。\n\n${content}`))
              .catch((error: Error) => {
                // Stopped before the build turn was a run: the plan is still in its document, nothing to say.
                if (!isTurnStartCancelled(error)) toast(error.message);
              }),

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

      // 归档 also reclaims the task's worktree, and un-archiving restores it.
      // The row moves at once; the PATCH answers when the worktree is done, and
      // a failure puts the task back where it was. `preserveChanges` is the
      // user's confirmation, asked for by the menu when the worktree is dirty.
      archiveThread: (threadId: string, archived: boolean, preserveChanges = false) => {
        setPendingArchive((pending) => new Map(pending).set(threadId, archived));
        const workspace = latest.current.threads.find((entry) => entry.id === threadId)?.workspace;
        const reclaims = workspace != null && workspace.reclaimed !== true;
        void client.patchThread(threadId, { archived, ...(archived && preserveChanges ? { preserveChanges: true } : {}) }).then(
          () => toast(archived ? (reclaims ? "已归档，worktree 已回收" : "已归档") : "已取消归档"),
          (error: Error) => {
            setPendingArchive((pending) => {
              const next = new Map(pending);
              next.delete(threadId);
              return next;
            });
            toast(error.message);
          },
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
        void deleteTask(threadId, () => client.deleteThread(threadId), {
          forgetChat: (id) => chats.forget(id),
          forgetCreated: (id) => setJustCreated((current) => (current?.id === id ? null : current)),
          // Read when the server has answered: by then the reader may be on another task.
          selected: () => latest.current.selectedThreadId,
          deselect: () => selectThread(null),
          toast,
        });
      },

      // Reclaim keeps the worktree's changes in git before removing it, so
      // both directions are recoverable; a dirty worktree is confirmed first.
      reclaimWorkspace: (threadId: string, preserveChanges = false): Promise<void> =>
        client.reclaimWorkspace(threadId, preserveChanges).then(
          () => toast("已回收，改动已保存"),
          (error: Error) => toast(error.message),
        ),

      /** Asked before 归档 / 回收: how many files the worktree has not committed. */
      countUncommitted: (threadId: string): Promise<number> => client.uncommittedFiles(threadId),

      restoreWorkspace: (threadId: string): Promise<void> =>
        client.restoreWorkspace(threadId).then(
          () => toast("已恢复"),
          (error: Error) => toast(error.message),
        ),

      // Nothing to say on success: the in-house engine's summary is written in
      // the background, and the log shows it going on and then its line; a
      // harness engine's request went in as a turn, with its own marker.
      compactThread: (threadId: string): Promise<void> =>
        client.compactThread(threadId).then(
          () => undefined,
          // A harness engine compacts by running a turn, and one stopped before
          // it began has nothing to report.
          (error: Error) => {
            if (!isTurnStartCancelled(error)) toast(error.message);
          },
        ),

      getChat: (threadId: string) => chats.get(threadId),
      whenReady: (threadId: string) => chats.whenReady(threadId),
      /** The task on screen, the only one whose chat follows its turn live. */
      focusChat: (threadId: string | null) => chats.focus(threadId),
      toast,
    }),
    [addProject, openProject, chats, client, selectChange, selectThread, toast],
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

  /** The snapshot, plus a task created a moment ago that it does not list yet. */
  const visibleThreads = useMemo(
    () => (justCreated != null && !state.threads.some((entry) => entry.id === justCreated.id) ? [justCreated, ...state.threads] : state.threads),
    [justCreated, state.threads],
  );

  return {
    state,
    client,
    engines,
    thread,
    visibleThreads,
    changes,
    selectedThreadId,
    activeProjectId,
    view,
    left,
    right,
    palette,
    grouping,
    settingsOpen,
    failedFirstSend,
    actions,
  };
}

export type Workbench = ReturnType<typeof useWorkbench>;
export type WorkbenchActions = Workbench["actions"];
