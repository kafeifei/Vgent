import type { UIMessage } from "ai";
import { FileDiff, FolderTree, ListChecks, ListTodo, Terminal, X } from "lucide-react";
import { ChangesPanel } from "@/features/changes/ChangesPanel";
import type { ChangesView } from "@/features/changes/useChanges";
import { FilesPanel } from "@/features/files/FilesPanel";
import { PlanDocument } from "@/features/plan/PlanDocument";
import { PlanPanel } from "@/features/plan/PlanPanel";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import type { QueueItem } from "@/features/worklog/queue";
import type { ApiClient } from "@/lib/api";
import type { ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

export type RightTab = "changes" | "files" | "term" | "plan" | "queue";

const TABS: ReadonlyArray<{ id: RightTab; label: string; Icon: typeof FileDiff }> = [
  { id: "changes", label: "变更", Icon: FileDiff },
  { id: "files", label: "文件", Icon: FolderTree },
  { id: "term", label: "终端", Icon: Terminal },
  { id: "plan", label: "计划", Icon: ListTodo },
  { id: "queue", label: "待处理", Icon: ListChecks },
];

/** Scrolls the log to a card and flashes it, without a keyframe of its own. */
function jumpTo(anchor: string): void {
  const element = document.getElementById(anchor);
  if (element == null) return;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.classList.add("ring-2", "ring-focus-ring");
  setTimeout(() => element.classList.remove("ring-2", "ring-focus-ring"), 1200);
}

/**
 * Right column. 待处理、变更、文件、终端、计划 all have content. 「待处理」 is
 * what this task is waiting on *you* for — open approvals and questions. The
 * messages waiting to be *sent* are 排队, and they live in the composer.
 *
 * The changes snapshot comes in as a prop: `useWorkbench` owns that fetch,
 * because the composer's 审查 pill reads the same numbers and neither view may
 * pay for its own request.
 */
export function RightPane({
  queue,
  open,
  tab,
  onTab,
  onClose,
  changes,
  client,
  threadId,
  refreshKey,
  messages,
  thread,
  live,
  onBuild,
}: {
  queue: QueueItem[];
  open: boolean;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  onClose: () => void;
  changes: ChangesView;
  client: ApiClient;
  /** The task whose directory the 文件 tab lists; nothing to show without one. */
  threadId: string | null;
  /** The thread's `updatedAt`: a new one means the engine wrote to disk. */
  refreshKey: string;
  /** The active thread's messages, for 终端 and 计划. Empty without a live thread. */
  messages: UIMessage[];
  /** The selected task, for the 变更 tab's 收口 bar. */
  thread: ThreadSummary | undefined;
  /** Whether that task's turn is still alive; every 收口 action is off while it is. */
  live: boolean;
  /** 「Build」 in the 计划 tab: back to Agent mode, with the document as the message. */
  onBuild: (threadId: string, content: string) => Promise<void>;
}) {
  const changeCount = changes.snapshot?.files.length ?? 0;

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border border-l bg-bg-elevated">
      <div role="tablist" className="flex flex-none items-center gap-3xs border-border border-b px-xs py-2xs">
        {TABS.map(({ id, label, Icon }) => {
          const count = id === "queue" ? queue.length : id === "changes" ? changeCount : 0;
          return (
            <button
              key={id}
              role="tab"
              type="button"
              title={label}
              aria-selected={tab === id}
              onClick={() => onTab(id)}
              className={cn(
                "relative inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-faint hover:bg-bg-hover hover:text-fg-muted",
                tab === id && "text-fg after:absolute after:right-2xs after:bottom-[calc(-1*var(--spacing-2xs)-1px)] after:left-2xs after:h-3xs after:rounded-full after:bg-fg after:content-['']",
              )}
            >
              <Icon className="size-lg" />
              {count > 0 && (
                <span className="rounded-full bg-bg-inset px-2xs font-mono text-2xs text-fg-faint">{count}</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          aria-label="收起 ⌘J"
          onClick={onClose}
          className="ml-auto grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="size-lg" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-sm">
        {tab === "queue" ? (
          <>
            <div className="mb-xs text-fg-muted text-xs">待处理</div>
            {queue.length === 0 ? (
              <p className="text-fg-faint text-xs">没有待审批或待回答的事项。</p>
            ) : (
              queue.map((item) => (
                <button
                  key={item.anchor}
                  type="button"
                  onClick={() => jumpTo(item.anchor)}
                  className="mb-2xs flex w-full items-center gap-xs rounded-sm border border-border p-xs text-left text-sm hover:border-border-strong hover:bg-bg-hover"
                >
                  <span
                    className={cn(
                      "flex-none rounded-full px-2xs text-2xs tracking-wider",
                      item.kind === "approval" ? "bg-warning-bg text-warning" : "bg-info-bg text-info",
                    )}
                  >
                    {item.kind === "approval" ? "审批" : "提问"}
                  </span>
                  <span className={cn("min-w-0 truncate", item.mono && "font-mono text-code")}>{item.label}</span>
                </button>
              ))
            )}
          </>
        ) : tab === "changes" ? (
          <ChangesPanel
            changes={changes}
            title={thread?.title ?? ""}
            live={live}
            {...(thread?.outcome != null ? { outcome: thread.outcome } : { outcome: undefined })}
            {...(thread?.pr != null ? { pr: thread.pr } : { pr: undefined })}
          />
        ) : tab === "files" ? (
          <FilesPanel client={client} threadId={threadId} active={open} refreshKey={refreshKey} />
        ) : tab === "term" ? (
          <TerminalPanel messages={messages} client={client} threadId={threadId} refreshKey={refreshKey} />
        ) : (
          <>
            {/* The document first — it is what Plan mode produces; the todo
                list below is what any engine reports while it works. */}
            <PlanDocument client={client} threadId={threadId} refreshKey={refreshKey} live={live} onBuild={onBuild} />
            <div className="mb-xs text-fg-muted text-xs">待办</div>
            <PlanPanel messages={messages} />
          </>
        )}
      </div>
    </aside>
  );
}
