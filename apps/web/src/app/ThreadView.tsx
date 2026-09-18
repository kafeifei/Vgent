import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import type { ChangesView } from "@/features/changes/useChanges";
import { Composer } from "@/features/composer/Composer";
import { TaskHeader } from "@/features/taskheader/TaskHeader";
import { WorkLog } from "@/features/worklog/WorkLog";
import { pendingQueue, type QueueItem } from "@/features/worklog/queue";
import type { TurnActions } from "@/features/worklog/Turn";
import { pendingAutoApprovals } from "@/lib/autoApprove";
import type { ApiClient } from "@/lib/api";
import type { ThreadSummary } from "@/lib/types";
import { isLiveThread, type WorkbenchActions } from "./useWorkbench";

/** Waits for the thread's history to land before mounting the chat view. */
export function ThreadView(props: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
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
  onQueue,
  onMessages,
  chat,
}: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  client: ApiClient;
  changes: ChangesView;
  rightOpen: boolean;
  onQueue: (queue: QueueItem[]) => void;
  onMessages: (messages: UIMessage[]) => void;
  chat: Chat<UIMessage>;
}) {
  const [draft, setDraft] = useState("");

  // The smoke client's wiring, minus what moved onto the shared `Chat` itself:
  // `sendAutomaticallyWhen` lives in `ThreadChats` (see the note there), and so
  // does the resume — `resume: true` here fires on mount, racing the history
  // load, and a replay applied to an empty chat throws on its first chunk.
  const { messages, status, error, addToolApprovalResponse, addToolOutput } = useChat({ chat });

  const live = isLiveThread(thread) || status === "streaming" || status === "submitted";
  const queue = useMemo(() => pendingQueue(messages), [messages]);

  useEffect(() => onQueue(queue), [onQueue, queue]);
  useEffect(() => onMessages(messages), [onMessages, messages]);

  const turnActions: TurnActions = useMemo(
    () => ({
      respondToApproval: (id, approved) => void addToolApprovalResponse({ id, approved }),
      alwaysAllow: (id, toolName) => {
        actions.allowTool(thread.id, toolName);
        void addToolApprovalResponse({ id, approved: true });
      },
      answerQuestions: (toolCallId, output) => void addToolOutput({ tool: "askUserQuestions", toolCallId, output }),
      openFile: (file) => actions.openChanges(file),
    }),
    [actions, addToolApprovalResponse, addToolOutput, thread.id],
  );

  // Every approval the task's allowlist already answers, answered once. The
  // `Chat`'s own `sendAutomaticallyWhen` then continues the turn, exactly as it
  // does for a click on 允许.
  const autoApproved = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of pendingAutoApprovals(messages, thread.alwaysAllow)) {
      if (autoApproved.current.has(id)) continue;
      autoApproved.current.add(id);
      void addToolApprovalResponse({ id, approved: true });
    }
  }, [addToolApprovalResponse, messages, thread.alwaysAllow]);
  // Stable: the composer debounces on this identity, and a streaming turn
  // re-renders this view constantly.
  const completeFiles = useCallback(
    (q: string) => client.listFiles(thread.id, { q, limit: 12 }).then((listing) => listing.entries),
    [client, thread.id],
  );

  const submit = () => {
    const text = draft.trim();
    if (text === "") return;
    // The one command the composer understands; everything else is a message.
    if (text === "/compact") {
      void actions.compactThread(thread.id);
      setDraft("");
      return;
    }
    actions.send(thread.id, text);
    setDraft("");
  };

  return (
    <>
      <TaskHeader
        thread={thread}
        live={live}
        pending={thread.pendingApprovals + queue.filter((item) => item.kind === "question").length}
        rightOpen={rightOpen}
        onRename={(title) => actions.rename(thread.id, title)}
        onSetEngine={(engine) => actions.setEngine(thread.id, engine)}
        onSetModel={(model) => actions.setModel(thread.id, model)}
        onSetPermission={(mode) => actions.setPermission(thread.id, mode)}
        onClearAlwaysAllow={() => actions.clearAllowedTools(thread.id)}
        onReclaimWorkspace={() => actions.reclaimWorkspace(thread.id)}
        onRestoreWorkspace={() => actions.restoreWorkspace(thread.id)}
        onStop={() => actions.stop(thread.id)}
        onToggleRight={actions.toggleRight}
        onBlocked={() => actions.toast("运行中不能改，先停止")}
      />

      <WorkLog
        messages={messages}
        thread={thread}
        live={live}
        error={thread.error ?? error?.message}
        actions={turnActions}
      />

      <div className="border-border border-t bg-bg px-md pt-sm pb-md">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onStop={() => actions.stop(thread.id)}
          live={live}
          engine={thread.engine}
          model={thread.model}
          onPickModel={(model) => actions.setModel(thread.id, model)}
          completeFiles={completeFiles}
          messages={messages}
          {...(changes.snapshot != null ? { changedFiles: changes.snapshot.files } : {})}
          onOpenChanges={() => actions.openChanges()}
        />
      </div>
    </>
  );
}
