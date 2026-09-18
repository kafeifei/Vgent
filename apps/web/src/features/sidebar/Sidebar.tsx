import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { Plus, Settings } from "lucide-react";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { BUILD_ID } from "@/lib/build";
import type { Project, ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { GROUPING_LABELS, groupThreads, type Grouping } from "./grouping";
import { TaskItem } from "./TaskItem";

const GROUPINGS: readonly Grouping[] = ["project", "status", "updated"];

/** Left column: new task, grouping control, grouped task list, settings foot. */
export function Sidebar({
  projects,
  threads,
  grouping,
  onGrouping,
  selectedThreadId,
  rail,
  onSelect,
  onNewTask,
  onOpenSettings,
  settingsOpen,
  getChat,
}: {
  projects: Project[];
  threads: ThreadSummary[];
  grouping: Grouping;
  onGrouping: (grouping: Grouping) => void;
  selectedThreadId: string | null;
  rail: boolean;
  onSelect: (threadId: string) => void;
  onNewTask: () => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
  /** Live chats only: the sidebar reads the current action off them. */
  getChat: (threadId: string) => Chat<UIMessage>;
}) {
  const groups = groupThreads(threads, projects, grouping);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-border border-r bg-bg">
      <div className={cn("flex-none", rail ? "p-2xs" : "p-sm")}>
        <button
          type="button"
          onClick={onNewTask}
          title="新任务 ⌘N"
          className={cn(
            "flex h-xl w-full items-center gap-xs rounded-md border border-border bg-bg-elevated text-fg text-sm hover:border-border-strong hover:bg-bg-active",
            rail ? "justify-center px-0" : "px-sm",
          )}
        >
          <Plus className="size-md flex-none" />
          {!rail && (
            <>
              <span>新任务</span>
              <span className="ml-auto font-mono text-fg-faint text-xs">⌘N</span>
            </>
          )}
        </button>
      </div>

      {!rail && (
        <div className="flex flex-none px-sm pb-2xs">
          <Popover
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-lg items-center gap-3xs rounded-sm px-2xs text-2xs text-fg-faint hover:bg-bg-hover"
              >
                <span>分组</span>
                <span className="text-fg-muted">{GROUPING_LABELS[grouping]}</span>
                <span>▾</span>
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
        {groups.map((group) => (
          <div key={group.key}>
            {!rail && (
              <div className="flex items-center gap-2xs px-xs pt-md pb-2xs text-2xs text-fg-faint tracking-wider">
                <span className="min-w-0 truncate">{group.title}</span>
                {group.count != null && <span className="font-mono">{group.count}</span>}
              </div>
            )}
            {group.threads.map((thread) => (
              <TaskItem
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedThreadId}
                rail={rail}
                chat={thread.status === "running" ? getChat(thread.id) : undefined}
                onSelect={() => onSelect(thread.id)}
              />
            ))}
          </div>
        ))}
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
                title={`构建 ${BUILD_ID}`}
              >
                build {BUILD_ID}
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
