import { isNoProject } from "@/lib/noProject";
import type { UIMessage } from "ai";
import { ChevronLeft, FileDiff, FolderTree, ListChecks, ListTodo, Terminal } from "lucide-react";
import { ChangesPanel } from "@/features/changes/ChangesPanel";
import type { ChangesView } from "@/features/changes/useChanges";
import { FilesPanel } from "@/features/files/FilesPanel";
import { PlanDocument } from "@/features/plan/PlanDocument";
import { PlanPanel } from "@/features/plan/PlanPanel";
import { TerminalPanel } from "@/features/terminal/TerminalPanel";
import type { QueueItem } from "@/features/worklog/queue";
import type { PreviewRequest } from "@/app/useWorkbench";
import type { ApiClient } from "@/lib/api";
import type { ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** 「home」 is the pane before anything is opened in it: a plain list of what it can show. */
export type RightTab = "home" | "changes" | "files" | "term" | "plan" | "queue";

const TABS: ReadonlyArray<{ id: Exclude<RightTab, "home">; label: string; Icon: typeof FileDiff }> = [
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
  changes,
  client,
  threadId,
  refreshKey,
  preview,
  onPreviewTaken,
  messages,
  thread,
  place,
  live,
  onBuild,
  onOpenPicture,
}: {
  queue: QueueItem[];
  open: boolean;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  changes: ChangesView;
  client: ApiClient;
  /** The task whose directory the 文件 tab lists; nothing to show without one. */
  threadId: string | null;
  /** The thread's `updatedAt`: a new one means the engine wrote to disk. */
  refreshKey: string;
  /** The file the 文件 tab was last asked to show. */
  preview: PreviewRequest | null;
  onPreviewTaken: () => void;
  /** The active thread's messages, for 终端 and 计划. Empty without a live thread. */
  messages: UIMessage[];
  /** The project the task runs on, named at the top of the list. */
  place: string | undefined;
  /** The selected task, for the 变更 tab's 收口 bar. */
  thread: ThreadSummary | undefined;
  /** Whether that task's turn is still alive; every 收口 action is off while it is. */
  live: boolean;
  /** 「Build」 in the 计划 tab: back to Agent mode, with the document as the message. */
  onBuild: (threadId: string, content: string) => Promise<void>;
  onOpenPicture: (path: string) => void;
}) {
  const changeCount = changes.snapshot?.files.length ?? 0;
  // 无项目 has no repository, so there is no diff to open: 变更 is not offered rather than opened onto an error.
  const tabs = isNoProject(thread?.projectId) ? TABS.filter((entry) => entry.id !== "changes") : TABS;
  const countOf = (id: RightTab): number => (id === "queue" ? queue.length : id === "changes" ? changeCount : 0);

  // Nothing opened yet: the pane is a quiet list on the window's own ground —
  // no border, no surface — naming where the task runs and what can be opened.
  if (tab === "home") {
    return (
      <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg">
        <div data-tauri-drag-region="deep" className="h-topbar flex-none" />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.25 pt-2xs">
          {place != null && <div className="truncate px-row-pad pb-2xs text-fg-muted text-sm">在 {place}</div>}
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onTab(id)}
              className="flex h-7 w-full flex-none items-center gap-xs rounded-md px-row-pad text-left text-body text-fg-secondary hover:bg-bg-hover hover:text-fg"
            >
              <Icon className="size-lg flex-none text-fg-muted" />
              <span className="min-w-0 truncate">{label}</span>
              {countOf(id) > 0 && <span className="ml-auto text-fg-faint text-sm">{countOf(id)}</span>}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border border-l bg-bg">
      <div role="tablist" data-tauri-drag-region="deep" className="flex h-topbar flex-none items-center gap-3xs border-border border-b pl-xs pr-sm">
        <button
          type="button"
          aria-label="回到列表"
          title="回到列表"
          onClick={() => onTab("home")}
          className="grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <ChevronLeft className="size-lg" />
        </button>
        {tabs.map(({ id, label, Icon }) => {
          const count = countOf(id);
          return (
            <button
              key={id}
              role="tab"
              type="button"
              title={label}
              aria-selected={tab === id}
              onClick={() => onTab(id)}
              className={cn(
                "relative inline-flex h-xl items-center gap-3xs rounded-md px-xs text-fg-muted hover:bg-bg-hover hover:text-fg",
                tab === id && "bg-bg-active text-fg",
              )}
            >
              <Icon className="size-lg" />
              {count > 0 && (
                <span className="rounded-full bg-bg-inset px-2xs font-mono text-2xs text-fg-faint">{count}</span>
              )}
            </button>
          );
        })}
        {/* The pane's toggle is pinned to the window's right edge, over this spot. */}
        <span aria-hidden className="ml-auto size-xl flex-none" />
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
          <FilesPanel client={client} threadId={threadId} active={open} refreshKey={refreshKey} preview={preview} onPreviewTaken={onPreviewTaken} onOpenPicture={onOpenPicture} />
        ) : tab === "term" ? (
          <TerminalPanel messages={messages} client={client} threadId={threadId} refreshKey={refreshKey} />
        ) : (
          <>
            {/* The document first — it is what Plan mode produces; the todo
                list below is what any engine reports while it works. */}
            <PlanDocument client={client} threadId={threadId} refreshKey={refreshKey} live={live} onBuild={onBuild} />
            <div className="mb-xs text-fg-muted text-xs">待办</div>
            <PlanPanel messages={messages} live={live} />
          </>
        )}
      </div>
    </aside>
  );
}
