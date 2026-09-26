import { useState, type ComponentType } from "react";
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ChevronRight, FolderOpen, FolderPlus, ListFilter, PanelLeft, Plus, Search, Settings, SquarePen } from "lucide-react";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ProjectPicker } from "@/components/ProjectPicker";
import { BUILD_DETAIL, BUILD_LABEL } from "@/lib/build";
import { hasTrafficLights } from "@/lib/host";
import type { Project, ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GROUPING_LABELS, groupThreads, type Grouping } from "./grouping";
import { TaskItem } from "./TaskItem";

const GROUPINGS: readonly Grouping[] = ["project", "status", "updated"];

/** The small icon buttons: the top bar's toggle, the section header's two, the foot's gear. */
export const SIDEBAR_ICON_BUTTON =
  "grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg";

/**
 * One of the plain entries at the top. They are entries, not buttons with
 * frames: the sidebar's top is a list of places to go, and the task list below
 * is what the eye should land on.
 */
function TopEntry({
  icon: Icon,
  label,
  shortcut,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label} ${shortcut}`}
      className="group flex h-row w-full items-center gap-row-pad rounded-md px-row-pad text-body text-fg hover:bg-bg-hover"
    >
      <Icon className="size-lg flex-none text-fg-muted" />
      <span className="min-w-0 truncate">{label}</span>
      <span className="ml-auto text-fg-faint text-xs opacity-0 group-hover:opacity-100">{shortcut}</span>
    </button>
  );
}

/** Left column: the window strip, the top entries, the grouped task list, the foot. */
export function Sidebar({
  projects,
  projectId,
  threads,
  grouping,
  onGrouping,
  selectedThreadId,
  connected,
  onSelect,
  onNewTask,
  onOpenPalette,
  onOpenSettings,
  onToggle,
  onOpenProject,
  onOpenFolder,
  onPickFolder,
  settingsOpen,
  getChat,
  onArchive,
  onCheckUncommitted,
  onUnread,
  onDelete,
  onRename,
}: {
  projects: Project[];
  /** The project of the current task or new-task draft. */
  projectId: string | null;
  threads: ThreadSummary[];
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  selectedThreadId: string | null;
  connected: boolean;
  onSelect: (threadId: string) => void;
  onNewTask: () => void;
  /** 搜索 ⌘K: the command palette, which is also how tasks are searched. */
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  /** 收起侧栏 ⌘B. */
  onToggle: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenFolder: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  settingsOpen: boolean;
  /** Live chats only: the sidebar reads the current action off them. */
  getChat: (threadId: string) => Chat<UIMessage>;
  /** `preserveChanges`: the row's menu confirmed the worktree's uncommitted changes go along. */
  onArchive: (threadId: string, archived: boolean, preserveChanges?: boolean) => void;
  /** How many files a task's worktree has not committed, asked before archiving it. */
  onCheckUncommitted: (threadId: string) => Promise<number>;
  /** 标为未读 / 标为已读 from the row's menu. */
  onUnread: (threadId: string, unread: boolean) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
}) {
  const groups = groupThreads(threads, projects, grouping);
  // Only 已归档 folds, and only for as long as the sidebar is mounted: it is a
  // glance, not a preference.
  const [expanded, setExpanded] = useState(false);
  const GroupIcon = grouping === "project" ? FolderOpen : null;

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border border-r bg-bg-sidebar">
      {/* The window strip: the traffic lights sit on its left under the desktop
          shell, and the whole strip drags the window. */}
      <div
        data-tauri-drag-region="deep"
        className={cn("flex h-topbar flex-none items-center pr-sm", hasTrafficLights() ? "pl-traffic" : "pl-sm")}
      >
        <button type="button" title="收起侧栏 ⌘B" aria-label="收起侧栏" onClick={onToggle} className={SIDEBAR_ICON_BUTTON}>
          <PanelLeft className="size-lg" />
        </button>
      </div>

      <div className="flex flex-none flex-col gap-px px-sm pt-sm">
        <TopEntry icon={SquarePen} label="新任务" shortcut="⌘N" onClick={onNewTask} />
        <TopEntry icon={Search} label="搜索" shortcut="⌘K" onClick={onOpenPalette} />
      </div>

      {/* Group the list, or open a workspace and start a task in it. */}
      <div className="mt-section-gap flex h-row flex-none items-center pr-sm pl-[calc(var(--spacing-sm)+var(--spacing-row-pad))]">
        <span className="min-w-0 flex-1 truncate text-fg-muted text-xs">工作区</span>
        <Popover
          align="end"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label="筛选"
              title={`分组方式：${GROUPING_LABELS[grouping]}`}
              className={SIDEBAR_ICON_BUTTON}
            >
              <ListFilter className="size-lg" />
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
        <ProjectPicker
          projects={projects}
          selectedId={projectId}
          onSelect={onOpenProject}
          onAdd={onOpenFolder}
          onPickFolder={onPickFolder}
          purpose="workspace"
          align="end"
          trigger={(props) => (
            <button type="button" {...props} aria-label="打开工作区" title="打开工作区" className={SIDEBAR_ICON_BUTTON}>
              <FolderPlus className="size-lg" />
            </button>
          )}
        />
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-sm pt-3xs pb-md">
        {groups.map((group) => {
          const folded = group.collapsible === true && !expanded;
          const title = (
            <>
              {group.collapsible === true ? (
                <ChevronRight
                  className={cn("size-lg flex-none text-fg-muted transition-transform duration-[var(--duration-fast)]", expanded && "rotate-90")}
                />
              ) : (
                GroupIcon != null && <GroupIcon className="size-lg flex-none text-fg-muted" />
              )}
              <span className="min-w-0 truncate">{group.title}</span>
              {group.count != null && <span className="text-fg-faint text-sm">{group.count}</span>}
            </>
          );
          const rowClass = "flex h-row w-full flex-none items-center gap-row-pad rounded-md px-row-pad text-left text-body text-fg";
          return (
            <div key={group.key} className="flex flex-col gap-px">
              {group.collapsible === true ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                  className={cn(rowClass, "hover:bg-bg-hover")}
                >
                  {title}
                </button>
              ) : group.projectId != null ? (
                <button
                  type="button"
                  title={`在 ${group.title} 中新建任务`}
                  aria-label={`在 ${group.title} 中新建任务`}
                  onClick={() => onOpenProject(group.projectId!)}
                  className={cn(rowClass, "hover:bg-bg-hover", selectedThreadId == null && group.projectId === projectId && "bg-bg-active")}
                >
                  {title}
                  <Plus className="ml-auto size-md flex-none text-fg-faint" />
                </button>
              ) : (
                <div className={rowClass}>{title}</div>
              )}
              {!folded &&
                group.threads.map((thread) => (
                  <TaskItem
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedThreadId}
                    chat={thread.status === "running" ? getChat(thread.id) : undefined}
                    onSelect={() => onSelect(thread.id)}
                    onArchive={(archived, preserveChanges) => onArchive(thread.id, archived, preserveChanges)}
                    onCheckUncommitted={() => onCheckUncommitted(thread.id)}
                    onUnread={(unread) => onUnread(thread.id, unread)}
                    onDelete={() => onDelete(thread.id)}
                    onRename={(title) => onRename(thread.id, title)}
                  />
                ))}
            </div>
          );
        })}
        {groups.length === 0 && <p className="px-row-pad py-sm text-fg-faint text-sm">还没有任务。</p>}
      </nav>

      <div className="flex h-foot flex-none items-center gap-sm pr-sm pl-[calc(var(--spacing-sm)+var(--spacing-row-pad))]">
        <span className="grid size-avatar flex-none place-items-center rounded-full bg-bg-strong font-medium text-fg-secondary text-sm">
          V
        </span>
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <span className="truncate text-body text-fg leading-tight">本机</span>
          <span
            className={cn("truncate text-2xs leading-tight", connected ? "text-fg-faint" : "text-danger")}
            title={BUILD_DETAIL}
          >
            {connected ? BUILD_LABEL : "连接断开"}
          </span>
        </div>
        <button
          type="button"
          title="设置 ⌘,"
          aria-label="设置"
          aria-pressed={settingsOpen}
          onClick={onOpenSettings}
          className={cn(SIDEBAR_ICON_BUTTON, settingsOpen && "bg-bg-active text-fg")}
        >
          <Settings className="size-lg" />
        </button>
      </div>
    </aside>
  );
}
