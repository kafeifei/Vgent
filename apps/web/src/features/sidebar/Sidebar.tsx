import { useState, type ComponentType } from "react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ListFilter, Plus, Search, Settings } from "lucide-react";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { BUILD_DETAIL, BUILD_LABEL } from "@/lib/build";
import type { Project, ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GROUPING_LABELS, groupThreads, type Grouping } from "./grouping";
import { TaskItem } from "./TaskItem";

const GROUPINGS: readonly Grouping[] = ["project", "status", "updated"];

/**
 * One of the two plain entries at the top. They are entries, not buttons with
 * frames: the sidebar's top is a list of places to go, and the task list below
 * is what the eye should land on.
 */
function TopEntry({
  icon: Icon,
  label,
  shortcut,
  rail,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
  rail: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} ${shortcut}`}
      className={cn(
        "flex h-xl w-full items-center gap-xs rounded-md text-fg-muted text-sm hover:bg-bg-hover hover:text-fg",
        rail ? "justify-center px-0" : "px-xs",
      )}
    >
      <Icon className="size-md flex-none" />
      {!rail && (
        <>
          <span>{label}</span>
          <span className="ml-auto font-mono text-2xs text-fg-faint">{shortcut}</span>
        </>
      )}
    </button>
  );
}

/** Left column: the two top entries, the grouped task list, the settings foot. */
export function Sidebar({
  projects,
  threads,
  grouping,
  onGrouping,
  selectedThreadId,
  rail,
  onSelect,
  onNewTask,
  onOpenPalette,
  onOpenSettings,
  settingsOpen,
  getChat,
  onArchive,
  onUnread,
  onDelete,
}: {
  projects: Project[];
  threads: ThreadSummary[];
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  selectedThreadId: string | null;
  rail: boolean;
  onSelect: (threadId: string) => void;
  onNewTask: () => void;
  /** 搜索 ⌘K: the command palette, which is also how tasks are searched. */
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** Live chats only: the sidebar reads the current action off them. */
  getChat: (threadId: string) => Chat<UIMessage>;
  onArchive: (threadId: string, archived: boolean) => void;
  /** 标为未读 / 标为已读 from the row's menu. */
  onUnread: (threadId: string, unread: boolean) => void;
  onDelete: (threadId: string) => void;
}) {
  const groups = groupThreads(threads, projects, grouping);
  // Only 已归档 folds, and only for as long as the sidebar is mounted: it is a
  // glance, not a preference.
  const [expanded, setExpanded] = useState(false);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border border-r bg-bg">
      <div className={cn("flex flex-none flex-col gap-3xs", rail ? "p-2xs" : "p-sm pb-2xs")}>
        <TopEntry icon={Plus} label="新任务" shortcut="⌘N" rail={rail} onClick={onNewTask} />
        <TopEntry icon={Search} label="搜索" shortcut="⌘K" rail={rail} onClick={onOpenPalette} />
      </div>

      {/* 任务 with one filter icon: what the list is grouped by is a setting of
          the list, not a control that has to sit in the way of it. */}
      {!rail && (
        <div className="flex flex-none items-center gap-2xs px-sm pt-xs pb-3xs">
          <span className="min-w-0 flex-1 truncate text-2xs text-fg-faint tracking-wider">任务</span>
          <Popover
            align="end"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                aria-label="筛选"
                title={`分组方式：${GROUPING_LABELS[grouping]}`}
                className="grid size-lg flex-none place-items-center rounded-sm text-fg-faint hover:bg-bg-hover hover:text-fg"
              >
                <ListFilter className="size-sm" />
              </button>
            )}
          >
            {(close) => (
              <>
                <PopTitle>分组方式</PopTitle>
                {GROUPINGS.map((entry) => (
                  <PopItem
                    key={entry}
                    selected={entry === grouping}
                    onClick={() => {
                      onGrouping(entry);
                      close();
                    }}
                  >
                    {GROUPING_LABELS[entry]}
                  </PopItem>
                ))}
              </>
            )}
          </Popover>
        </div>
      )}

      <nav className={cn("min-h-0 flex-1 overflow-y-auto pb-md", rail ? "px-2xs" : "px-sm")}>
        {groups.map((group) => {
          const folded = group.collapsible === true && !expanded;
          return (
            <div key={group.key}>
              {!rail &&
                (group.collapsible === true ? (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((open) => !open)}
                    className="flex w-full items-center gap-2xs rounded-sm px-xs pt-md pb-2xs text-2xs text-fg-faint tracking-wider hover:text-fg-muted"
                  >
                    <span className="flex-none">{expanded ? "▾" : "▸"}</span>
                    <span className="min-w-0 truncate">{group.title}</span>
                    {group.count != null && <span className="font-mono">{group.count}</span>}
                  </button>
                ) : (
                  <div className="flex items-center gap-2xs px-xs pt-md pb-2xs text-2xs text-fg-faint tracking-wider">
                    <span className="min-w-0 truncate">{group.title}</span>
                    {group.count != null && <span className="font-mono">{group.count}</span>}
                  </div>
                ))}
              {!folded &&
                group.threads.map((thread) => (
                  <TaskItem
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedThreadId}
                    rail={rail}
                    chat={thread.status === "running" ? getChat(thread.id) : undefined}
                    onSelect={() => onSelect(thread.id)}
                    onArchive={(archived) => onArchive(thread.id, archived)}
                    onUnread={(unread) => onUnread(thread.id, unread)}
                    onDelete={() => onDelete(thread.id)}
                  />
                ))}
            </div>
          );
        })}
        {threads.length === 0 && !rail && <p className="px-xs py-md text-fg-faint text-xs">还没有任务。</p>}
      </nav>

      <div className={cn("flex flex-none items-center gap-xs border-border border-t py-xs", rail ? "justify-center px-0" : "px-sm")}>
        <span className="grid size-avatar flex-none place-items-center rounded-full bg-bg-active font-bold text-fg-muted text-xs">
          V
        </span>
        {!rail && (
          <>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <span className="truncate text-fg-muted text-sm leading-tight">本机</span>
              <span
                className="truncate font-mono text-2xs text-fg-faint leading-tight"
                title={BUILD_DETAIL}
              >
                {BUILD_LABEL}
              </span>
            </div>
            <button
              type="button"
              title="设置"
              aria-pressed={settingsOpen}
              onClick={onOpenSettings}
              className={cn(
                "grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg",
                settingsOpen && "bg-bg-active text-fg",
              )}
            >
              <Settings className="size-md" />
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
