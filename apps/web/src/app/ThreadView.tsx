import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { toFileParts, type Attachment } from "@/features/composer/attachments";
import type { SlashCommand } from "@/features/composer/slash";
import type { ChangesView } from "@/features/changes/useChanges";
import { Composer } from "@/features/composer/Composer";
import { taskBranch, taskLocation } from "@/features/composer/location";
import { TaskHeader } from "@/features/taskheader/TaskHeader";
import { SetupNotice } from "@/features/workspace/SetupNotice";
import { FileAccessProvider } from "@/features/files/fileAccess";
import { WorkLog } from "@/features/worklog/WorkLog";
import { pendingQueue, type QueueItem } from "@/features/worklog/queue";
import type { TurnActions } from "@/features/worklog/Turn";
import { pendingAutoApprovals } from "@/lib/autoApprove";
import type { ApiClient } from "@/lib/api";
import { useDraft } from "@/lib/drafts";
import { previewKindOf } from "@/lib/preview";
import type { EngineDescriptor, EngineId, PermissionMode, ThreadSummary } from "@/lib/types";
import { isLiveThread, type WorkbenchActions } from "./useWorkbench";

/** Waits for the thread's history to land before mounting the chat view. */
export function ThreadView(props: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
  leftOpen: boolean;
  /** 引擎能力表, for the composer's model picker and its 「不支持审批」 notice. */
  engines: EngineDescriptor[];
  /** The global 运行模式; the composer's notice reads it. */
  runMode: PermissionMode | undefined;
  /** 记住上次选的引擎, by model. */
  modelEngines: Readonly<Record<string, EngineId>> | undefined;
  /** The global 「一直允许」 list, which auto-answers matching approvals. */
  allowlist: readonly string[] | undefined;
  onQueue: (queue: QueueItem[]) => void;
  onMessages: (messages: UIMessage[]) => void;
}) {
  const { thread, actions } = props;
  const [chat, setChat] = useState<Chat<UIMessage> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChat(null);
    void actions.whenReady(thread.id).then(() => {
      if (!cancelled) setChat(actions.getChat(thread.id));
    });
    return () => {
      cancelled = true;
    };
  }, [actions, thread.id]);

  if (chat == null) return <div className="grid place-items-center text-fg-faint text-sm">加载中…</div>;
  return <ThreadChatView key={thread.id} {...props} chat={chat} />;
}

function ThreadChatView({
  thread,
  actions,
  client,
  changes,
  rightOpen,
  leftOpen,
  engines,
  runMode,
  modelEngines,
  allowlist,
  onQueue,
  onMessages,
  chat,
}: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
  leftOpen: boolean;
  engines: EngineDescriptor[];
  runMode: PermissionMode | undefined;
  /** 记住上次选的引擎, by model. */
  modelEngines: Readonly<Record<string, EngineId>> | undefined;
  allowlist: readonly string[] | undefined;
  onQueue: (queue: QueueItem[]) => void;
  onMessages: (messages: UIMessage[]) => void;
  chat: Chat<UIMessage>;
}) {
  /**
   * 草稿不丢: this view is remounted per task (`key={thread.id}`) and wiped by a
   * reload, so the draft is kept on the server — `localStorage` is only the
   * cache that paints it before the server answers. It is cleared only once the
   * message really went out: sent and accepted, or accepted onto the queue.
   */
  const draft = useDraft(thread.id, client);

  // The smoke client's wiring, minus what moved onto the shared `Chat` itself:
  // `sendAutomaticallyWhen` lives in `ThreadChats` (see the note there), and so
  // does the resume — `resume: true` here fires on mount, racing the history
  // load, and a replay applied to an empty chat throws on its first chunk.
  const { messages, status, error, addToolApprovalResponse, addToolOutput } = useChat({ chat });

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
  const fileAccess = useMemo(
    () => ({ client, threadId: thread.id, refreshKey: filesKey, openFile: actions.openPreview, openDrawing: actions.openDrawing }),
    [actions.openDrawing, actions.openPreview, client, filesKey, thread.id],
  );

  const turnActions: TurnActions = useMemo(
    () => ({
      respondToApproval: (id, approved) => void addToolApprovalResponse({ id, approved }),
      alwaysAllow: (id, entries) => {
        actions.allowTools(entries);
        void addToolApprovalResponse({ id, approved: true });
      },
      answerQuestions: (toolCallId, output) => void addToolOutput({ tool: "askUserQuestions", toolCallId, output }),
      // A picture or a document is opened as what it is; code is opened as its diff.
      openFile: (file) => (previewKindOf(file) != null ? actions.openPreview(file) : actions.openChanges(file)),
      fork: (messageId) => actions.forkThread(thread.id, messageId),
      restoreLatest: () => restoreCheckpoint({ latest: true }),
    }),
    [actions, addToolApprovalResponse, addToolOutput, restoreCheckpoint, thread.id],
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
  // 附件 belong to the message being written, like the text; unlike the text
  // they are not saved as a draft — they are large and cheap to pick again.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const submit = () => {
    const text = draft.value.trim();
    if ((text === "" && attachments.length === 0) || sending.current) return;
    // 运行中按 Enter = 排队。The server holds it and starts it itself once this
    // turn settles idle, so the draft may only be dropped once it took it.
    if (live) {
      // The queue holds text only; a message with files waits for the turn to end.
      if (attachments.length > 0) {
        actions.toast("带附件的消息不能排队，等这一轮结束再发");
        return;
      }
      sending.current = true;
      void actions.queueMessage(thread.id, text).then((queued) => {
        sending.current = false;
        if (queued) draft.clear();
      });
      return;
    }
    // The one command the composer understands; everything else is a message.
    if (text === "/compact") {
      void actions.compactThread(thread.id);
      draft.clear();
      return;
    }
    // 发送失败不吞草稿: the text only leaves the composer once the server took
    // it; the error itself is already toasted by the chat registry.
    sending.current = true;
    void actions.send(thread.id, text, toFileParts(attachments)).then((accepted) => {
      sending.current = false;
      if (!accepted) return;
      draft.clear();
      setAttachments([]);
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
  const queued = thread.queue ?? [];
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
      {/* One grid row: the header, plus the setup line when there is one. */}
      <div>
        <TaskHeader
          thread={thread}
          pending={thread.pendingApprovals + queue.filter((item) => item.kind === "question").length}
          leftOpen={leftOpen}
          rightOpen={rightOpen}
          onReclaimWorkspace={() => actions.reclaimWorkspace(thread.id)}
          onRestoreWorkspace={() => actions.restoreWorkspace(thread.id)}
          onToggleLeft={actions.toggleLeft}
          onToggleRight={actions.toggleRight}
        />
        <SetupNotice
          setup={thread.workspace?.setup}
          onOpenLog={() => {
            actions.setRightTab("term");
            actions.openRight();
          }}
        />
      </div>

      <FileAccessProvider value={fileAccess}>
        <WorkLog
          messages={messages}
          thread={thread}
          live={live}
          error={thread.error ?? error?.message}
          actions={turnActions}
          allowlist={allowlist ?? []}
        />
      </FileAccessProvider>

      <div className="bg-bg px-md pb-xs">
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
          modelEngines={modelEngines}
          onRememberEngine={actions.rememberModelEngine}
          // Same rule as the 思考 chip below: a running turn already carries
          // the model it started with, so switching it mid-flight would be a lie.
          onPickModel={(engine, model) =>
            live ? actions.toast("运行中不能改，先停止") : actions.setModel(thread.id, engine, model)
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
          {...(branch != null ? { branch } : {})}
          branchTitle={
            thread.workspace == null ? "主目录当前分支，任务直接改这里的文件" : "这个任务自己的分支"
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
      </div>
    </>
  );
}
