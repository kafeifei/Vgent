import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { toFileParts } from "@/features/composer/attachments";
import type { SlashCommand } from "@/features/composer/slash";
import type { ChangesView } from "@/features/changes/useChanges";
import { ArchivedBar } from "@/features/composer/ArchivedBar";
import { Composer } from "@/features/composer/Composer";
import { taskBranch, taskLocation } from "@/features/composer/location";
import { TaskHeader } from "@/features/taskheader/TaskHeader";
import { FileAccessProvider } from "@/features/files/fileAccess";
import { WorkLog } from "@/features/worklog/WorkLog";
import { pendingQueue, type QueueItem } from "@/features/worklog/queue";
import type { TurnActions } from "@/features/worklog/Turn";
import { describeTool } from "@/features/worklog/toolMeta";
import { pendingAutoApprovals } from "@/lib/autoApprove";
import type { ApiClient } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { previewKindOf } from "@/lib/preview";
import { CHAT_THROTTLE_MS, transportErrorText } from "@/lib/threadChats";
import type { EngineDescriptor, ModelPick, PermissionMode, ThreadSummary } from "@/lib/types";
import { isLiveThread, type WorkbenchActions } from "./useWorkbench";

export type ThreadViewActions = Pick<WorkbenchActions,
  "whenReady" | "getChat" | "toast" | "allowTools" | "openPreview" | "openChanges" | "focusTerminal" | "inspectTool" | "forkThread" | "setRightTab" | "openRight" | "toggleLeft" | "compactThread" | "newTask" | "queueMessage" | "send" | "stop" | "rememberModelPick" | "setModel" | "setReasoningEffort" | "setContextWindow" | "setServiceTier" | "setMode" | "sendQueued" | "editQueued" | "deleteQueued" | "reorderQueue" | "steerQueued" | "reclaimWorkspace" | "restoreWorkspace" | "archiveThread" | "countUncommitted"
>;

/** Waits for the thread's history to land before mounting the chat view. */
export function ThreadView(props: {
  thread: ThreadSummary;
  failedFirstSend: boolean;
  actions: ThreadViewActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
  leftOpen: boolean;
  /** 引擎能力表, for the composer's model picker and its 「不支持审批」 notice. */
  engines: EngineDescriptor[];
  /** The global 运行模式; the composer's notice reads it. */
  runMode: PermissionMode | undefined;
  /** 记住上次选择, by model. */
  modelPicks: Readonly<Record<string, ModelPick>> | undefined;
  /** The global 「一直允许」 list, which auto-answers matching approvals. */
  allowlist: readonly string[] | undefined;
  onQueue: (queue: QueueItem[]) => void;
  onMessages: (messages: UIMessage[]) => void;
  onOpenPicture: (path: string) => void;
}) {
  const { thread, actions } = props;
  const [chat, setChat] = useState<Chat<UIMessage> | null>(null);
  // `actions` is rebuilt whenever any task changes at all — a toggle on this
  // one, a token streaming into another. Loading the chat must hang on the
  // task alone: with `actions` as a dependency every such change tore the
  // whole view down to 「加载中…」 and scrolled it in again from the top.
  const latest = useRef(actions);
  latest.current = actions;

  useEffect(() => {
    let cancelled = false;
    setChat(null);
    void latest.current.whenReady(thread.id).then(() => {
      if (!cancelled) setChat(latest.current.getChat(thread.id));
    });
    return () => {
      cancelled = true;
    };
  }, [thread.id]);

  // The effect clears `chat` one paint later. Until then the state still holds
  // the task just left — mounting that log under the new id records the scroll
  // place on the wrong task, so the next click opens neither where it was nor
  // at the end.
  if (chat == null || chat.id !== thread.id) return <div className="grid place-items-center text-fg-faint text-sm">加载中…</div>;
  return <ThreadChatView key={thread.id} {...props} chat={chat} />;
}

function ThreadChatView({
  thread,
  failedFirstSend,
  actions,
  client,
  changes,
  rightOpen,
  leftOpen,
  engines,
  runMode,
  modelPicks,
  allowlist,
  onQueue,
  onMessages,
  onOpenPicture,
  chat,
}: {
  thread: ThreadSummary;
  failedFirstSend: boolean;
  actions: ThreadViewActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
  leftOpen: boolean;
  engines: EngineDescriptor[];
  runMode: PermissionMode | undefined;
  /** 记住上次选择, by model. */
  modelPicks: Readonly<Record<string, ModelPick>> | undefined;
  allowlist: readonly string[] | undefined;
  onQueue: (queue: QueueItem[]) => void;
  onMessages: (messages: UIMessage[]) => void;
  onOpenPicture: (path: string) => void;
  chat: Chat<UIMessage>;
}) {
  /**
   * 草稿不丢: this view is remounted per task (`key={thread.id}`) and wiped by a
   * reload, so the draft is kept on the server — `localStorage` is only the
   * cache that paints it before the server answers. It is cleared only once the
   * message really went out: sent and accepted, or accepted onto the queue.
   */
  const draft = useDraft(thread.id, client);
  useEffect(() => {
    if (failedFirstSend) draft.refresh();
  }, [draft.refresh, failedFirstSend]);

  // The smoke client's wiring, minus what moved onto the shared `Chat` itself:
  // `sendAutomaticallyWhen` lives in `ThreadChats` (see the note there), and so
  // does the resume — `resume: true` here fires on mount, racing the history
  // load, and a replay applied to an empty chat throws on its first chunk.
  const { messages, status, error, addToolApprovalResponse, addToolOutput } = useChat({ chat, throttle: CHAT_THROTTLE_MS });

  const live = isLiveThread(thread) || status === "streaming" || status === "submitted";
  const queue = useMemo(() => pendingQueue(messages), [messages]);

  useEffect(() => onQueue(queue), [onQueue, queue]);
  useEffect(() => onMessages(messages), [onMessages, messages]);

  /**
   * 回到最新, for a task an older build left standing at an earlier checkpoint.
   * Nothing in the log offers 恢复到此处 any more (分叉 took its place), so this
   * is the only direction left.
   */
  const restoreCheckpoint = useCallback(
    (target: { latest: true }) => {
      void (async () => {
        try {
          const result = await client.restoreCheckpoint(thread.id, target);
          actions.toast(result.whole ? "已整个目录恢复" : `已回到最新，放回 ${result.files} 个文件`);
        } catch (failure) {
          actions.toast(failure instanceof Error ? failure.message : String(failure));
        }
        // The tree moved under the 变更 panel and the composer's 审查 pill.
        changes.refresh();
      })();
    },
    [actions, changes, client, thread.id],
  );

  // A running turn rewrites its files many times; what the log shows is refetched once it ends.
  const filesKey = live ? "live" : thread.updatedAt;
  const openFile = useCallback((file: string) => {
    const kind = previewKindOf(file);
    if (kind === "image" || kind === "svg") onOpenPicture(file);
    else if (kind === "markdown") actions.openPreview(file);
    else actions.openChanges(file);
  }, [actions, onOpenPicture]);
  const fileAccess = useMemo(
    () => ({ client, threadId: thread.id, refreshKey: filesKey, openFile, notify: actions.toast }),
    [actions.toast, client, filesKey, openFile, thread.id],
  );

  const turnActions: TurnActions = useMemo(
    () => ({
      respondToApproval: (id, approved) => void addToolApprovalResponse({ id, approved }),
      alwaysAllow: (id, entries) => {
        actions.allowTools(entries);
        void addToolApprovalResponse({ id, approved: true });
      },
      answerQuestions: (toolCallId, output) => void addToolOutput({ tool: "askUserQuestions", toolCallId, output }),
      openFile,
      inspect: (part) => {
        const display = describeTool(part);
        if (display.kind === "bash") actions.focusTerminal(part.toolCallId);
        else if (display.kind === "read" && display.target !== "") actions.openPreview(display.target);
        else if (display.file != null) openFile(display.file);
        else actions.inspectTool(part.toolCallId);
      },
      fork: (messageId) => actions.forkThread(thread.id, messageId),
      restoreLatest: () => restoreCheckpoint({ latest: true }),
      sendSteer: (itemId, interrupt) => actions.sendQueued(thread.id, itemId, { interrupt }),
    }),
    [actions, addToolApprovalResponse, addToolOutput, openFile, restoreCheckpoint, thread.id],
  );

  // Every approval the global allowlist already answers, answered once. The
  // `Chat`'s own `sendAutomaticallyWhen` then continues the turn, exactly as it
  // does for a click on 允许.
  const autoApproved = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of pendingAutoApprovals(messages, allowlist)) {
      if (autoApproved.current.has(id)) continue;
      autoApproved.current.add(id);
      void addToolApprovalResponse({ id, approved: true });
    }
  }, [addToolApprovalResponse, allowlist, messages]);
  // Stable: the composer debounces on this identity, and a streaming turn
  // re-renders this view constantly.
  const completeFiles = useCallback(
    (q: string) => client.listFiles(thread.id, { q, limit: 12 }).then((listing) => listing.entries),
    [client, thread.id],
  );

  // The `/` menu's own rows, after 模式: what this task can be told to do
  // without going through the model.
  const canCompact = engines.find((entry) => entry.id === thread.engine)?.capabilities.compact === true;
  const commands = useMemo<SlashCommand[]>(
    () => [
      ...(canCompact
        ? [
            {
              id: "compact",
              aliases: ["summarize"],
              label: "压缩上下文",
              hint: "把这段对话压成摘要，腾出上下文",
              section: "操作",
              disabledReason: live ? "运行中不能压缩" : undefined,
              run: () => void actions.compactThread(thread.id),
            },
          ]
        : []),
      { id: "new", label: "新任务", hint: "回到空白页开一个新任务", section: "操作", run: actions.newTask },
    ],
    [actions, canCompact, live, thread.id],
  );

  /** One in-flight submit at a time: the text now stays until the server answers. */
  const sending = useRef(false);
  // 附件 belong to the message being written, like the text, and are kept in
  // the same draft — a file dropped in before a task switch is still there.
  const { attachments, setAttachments } = draft;
  const submit = (delivery: "steer" | "queue" = "steer") => {
    const text = draft.value.trim();
    if ((text === "" && attachments.length === 0) || sending.current) return;
    if (thread.workspaceState != null || (thread.workspace?.setup?.status === "running" && thread.messageCount === 0)) {
      actions.toast(thread.workspaceState === "failed" ? "worktree 创建失败，请新建任务" : "正在准备 worktree，请稍候");
      return;
    }
    // Enter steers the active turn; Command+Enter explicitly waits for the next turn.
    if (live) {
      // The queue holds text only; a message with files waits for the turn to end.
      if (attachments.length > 0) {
        actions.toast("带附件的消息不能排队，等这一轮结束再发");
        return;
      }
      sending.current = true;
      void draft.submit(() => actions.queueMessage(thread.id, text, delivery)).finally(() => {
        sending.current = false;
      });
      return;
    }
    // The one command the composer understands; everything else is a message.
    if (text === "/compact") {
      void actions.compactThread(thread.id);
      // The command leaves; a file waiting with it is not what was consumed.
      draft.edit("");
      return;
    }
    // 发送失败不吞草稿: the text only leaves the composer once the server took
    // it; the error itself is already toasted by the chat registry.
    sending.current = true;
    void draft.submit(() => actions.send(thread.id, text, toFileParts(attachments))).finally(() => {
      sending.current = false;
    });
  };

  // The row under the composer: this task's branch and the directory it edits.
  // Both prefer the task's own record and fall back to the 变更快照, so the row
  // is filled in before any diff has been fetched.
  const branch = taskBranch(thread, changes.snapshot);
  const location = taskLocation(thread, changes.snapshot);

  /**
   * Why the 排队条 says the queue is not moving. A turn that is still running
   * needs no explanation — it is about to take the next one.
   */
  const queued = (thread.queue ?? []).filter(item => item.mode !== "steer");
  const queueNote =
    thread.status === "interrupted"
      ? "已停止，排队暂停"
      : thread.status === "error"
        ? "上一轮出错，排队暂停"
        : thread.status === "awaiting-approval" || thread.status === "awaiting-input"
          ? "等你处理审批或回答后继续"
          : undefined;

  return (
    <>
      <div className="min-w-0">
        <TaskHeader
          thread={thread}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onReclaimWorkspace={(preserveChanges) => actions.reclaimWorkspace(thread.id, preserveChanges)}
          onCheckUncommitted={() => actions.countUncommitted(thread.id)}
          onRestoreWorkspace={() => actions.restoreWorkspace(thread.id)}
          onToggleLeft={actions.toggleLeft}
        />
      </div>

      <FileAccessProvider value={fileAccess}>
        <WorkLog
          messages={messages}
          thread={thread}
          live={live}
          // Only a task that ended in error has one to show: older builds also left a failed tool call's text here.
          error={(thread.status === "error" ? thread.error : undefined) ?? (error != null ? transportErrorText(error.message) : undefined)}
          actions={turnActions}
          allowlist={allowlist ?? []}
          client={client}
        />
      </FileAccessProvider>

      <div className="bg-bg px-md pb-xs">
        {thread.archivedAt != null ? (
          // The draft stays on the server meanwhile, so 取消归档 brings the composer back as it was.
          <ArchivedBar onUnarchive={() => actions.archiveThread(thread.id, false)} />
        ) : (
          <Composer
            value={draft.value}
            onChange={draft.edit}
            attachments={attachments}
            onAttachments={setAttachments}
            commands={commands}
            // Opening a task — including the one the empty state just started —
            // puts the caret in its composer.
            autoFocus
            onSubmit={submit}
            onStop={() => actions.stop(thread.id)}
            live={live}
            engines={engines}
            engine={thread.engine}
            // A task with history is stuck with its engine; the picker greys the
            // other groups out and says why.
            engineLocked={thread.messageCount > 0}
            model={thread.model}
            runMode={runMode}
            modelPicks={modelPicks}
            onRememberPick={actions.rememberModelPick}
            // Same rule as the 思考 chip below: a running turn already carries
            // the model it started with, so switching it mid-flight would be a lie.
            onPickModel={(engine, model, options) =>
              live ? actions.toast("运行中不能改，先停止") : actions.setModel(thread.id, engine, model, options)
            }
            reasoningEffort={thread.reasoningEffort}
            // Same rule as the header's pills.
            onPickReasoning={(level) =>
              live ? actions.toast("运行中不能改，先停止") : actions.setReasoningEffort(thread.id, level)
            }
            contextWindow={thread.contextWindow}
            onPickContext={(window) =>
              live ? actions.toast("运行中不能改，先停止") : actions.setContextWindow(thread.id, window)
            }
            serviceTier={thread.serviceTier}
            onPickServiceTier={(tier) =>
              live ? actions.toast("运行中不能改，先停止") : actions.setServiceTier(thread.id, tier)
            }
            mode={thread.mode ?? "agent"}
            onPickMode={(mode) => (live ? actions.toast("运行中不能改，先停止") : actions.setMode(thread.id, mode))}
            queue={queued}
            queueNote={queueNote}
            // A paused queue is resumed by hand from its head item. While a turn
            // is still going the same spot offers 「打断并发送」 instead: nothing
            // jumps a running turn unless the user says so.
            {...(live
              ? { onInterruptWithQueued: (itemId: string) => actions.sendQueued(thread.id, itemId, { interrupt: true }) }
              : { onSendQueued: (itemId: string) => actions.sendQueued(thread.id, itemId) })}
            onEditQueued={(itemId, text) => actions.editQueued(thread.id, itemId, text)}
            onDeleteQueued={(itemId) => actions.deleteQueued(thread.id, itemId)}
            onReorderQueued={(ids) => actions.reorderQueue(thread.id, ids)}
            onSteerQueued={(itemId) => actions.steerQueued(thread.id, itemId)}
            {...(branch != null ? { branch } : {})}
            branchTitle={
              thread.workspace == null && thread.workspaceState == null ? "主目录当前分支，任务直接改这里的文件" : "这个任务自己的分支"
            }
            // 运行位置 is settled once the task exists, so here it is a label and
            // not a picker; the directory itself is one hover away.
            location={
              <span
                title={location.path ?? "位置未知"}
                className="inline-flex min-w-0 items-center"
              >
                <span className="min-w-0 truncate">{location.label}</span>
              </span>
            }
            completeFiles={completeFiles}
            messages={messages}
            {...(changes.snapshot != null ? { changedFiles: changes.snapshot.files } : {})}
            onOpenChanges={() => actions.openChanges()}
          />
        )}
      </div>
    </>
  );
}
