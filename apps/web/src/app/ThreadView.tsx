import { useEffect, useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Composer } from "@/features/composer/Composer";
import { TaskHeader } from "@/features/taskheader/TaskHeader";
import { WorkLog } from "@/features/worklog/WorkLog";
import { pendingQueue, type QueueItem } from "@/features/worklog/queue";
import type { TurnActions } from "@/features/worklog/Turn";
import type { ThreadSummary } from "@/lib/types";
import { isLiveThread, type WorkbenchActions } from "./useWorkbench";

/** Waits for the thread's history to land before mounting the chat view. */
export function ThreadView(props: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  rightOpen: boolean;
  onQueue: (queue: QueueItem[]) => void;
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
  rightOpen,
  onQueue,
  chat,
}: {
  thread: ThreadSummary;
  actions: WorkbenchActions;
  rightOpen: boolean;
  onQueue: (queue: QueueItem[]) => void;
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

  const turnActions: TurnActions = useMemo(
    () => ({
      respondToApproval: (id, approved) => void addToolApprovalResponse({ id, approved }),
      answerQuestions: (toolCallId, output) => void addToolOutput({ tool: "askUserQuestions", toolCallId, output }),
      openFile: (file) => actions.openChanges(file),
    }),
    [actions, addToolApprovalResponse, addToolOutput],
  );

  const submit = () => {
    if (draft.trim() === "") return;
    actions.send(thread.id, draft.trim());
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
        />
      </div>
    </>
  );
}
