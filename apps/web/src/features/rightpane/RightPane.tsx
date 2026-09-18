import { FileDiff, FolderTree, ListChecks, ListTodo, Terminal, X } from "lucide-react";
import { ChangesPanel } from "@/features/changes/ChangesPanel";
import { useChanges } from "@/features/changes/useChanges";
import { FilesPanel } from "@/features/files/FilesPanel";
import type { QueueItem } from "@/features/worklog/queue";
import type { ApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";

export type RightTab = "changes" | "files" | "term" | "plan" | "queue";

const TABS: ReadonlyArray<{ id: RightTab; label: string; Icon: typeof FileDiff }> = [
  { id: "changes", label: "变更", Icon: FileDiff },
  { id: "files", label: "文件", Icon: FolderTree },
  { id: "term", label: "终端", Icon: Terminal },
  { id: "plan", label: "计划", Icon: ListTodo },
  { id: "queue", label: "队列", Icon: ListChecks },
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
 * Right column. 队列 / 变更 / 文件 have content; 终端 / 计划 are placeholders.
 *
 * The changes snapshot is loaded here rather than inside `ChangesPanel` so the
 * 变更 tab can carry its file count — and so a collapsed pane, which stays
 * mounted at zero width, does not keep asking git for one.
 */
export function RightPane({
  queue,
  open,
  tab,
  onTab,
  onClose,
  client,
  threadId,
  file,
  onSelectFile,
  refreshKey,
  toast,
}: {
  queue: QueueItem[];
  open: boolean;
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  onClose: () => void;
  client: ApiClient;
  /** The task whose directory the 变更 tab diffs; nothing to show without one. */
  threadId: string | null;
  file: string | null;
  onSelectFile: (path: string | null) => void;
  /** The thread's `updatedAt`: a new one means the engine wrote to disk. */
  refreshKey: string;
  toast: (text: string) => void;
}) {
  const changes = useChanges({
    client,
    threadId,
    active: open && tab === "changes",
    refreshKey,
    selected: file,
    onSelect: onSelectFile,
    toast,
  });
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
          <ChangesPanel changes={changes} />
        ) : tab === "files" ? (
          <FilesPanel client={client} threadId={threadId} active={open} refreshKey={refreshKey} />
        ) : (
          <p className="text-fg-faint text-xs">下一步接入</p>
        )}
      </div>
    </aside>
  );
}
