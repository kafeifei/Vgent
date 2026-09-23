import { useState } from "react";
import { GitFork, PanelRight } from "lucide-react";
import { STRIP_ICON_BUTTON, TopStrip } from "@/components/TopStrip";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import type { ThreadSummary, ThreadWorkspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The worktree glyph's popover: where the task's files are, and reclaim / restore. */
function WorkspaceMenu({
  workspace,
  running,
  onReclaim,
  onRestore,
  close,
}: {
  workspace: ThreadWorkspace;
  running: boolean;
  onReclaim: () => Promise<void>;
  onRestore: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const reclaimed = workspace.reclaimed === true;
  // Only a live run holds the directory open, which is the very condition the
  // server refuses a reclaim on (`runs.isRunning`).
  const blocked = busy || (!reclaimed && running);

  return (
    <>
      <PopTitle>工作目录</PopTitle>
      <div className="px-xs pb-2xs text-xs">
        <p className="m-0 select-text break-all font-mono text-fg-muted">{workspace.path}</p>
        <p className="m-0 mt-2xs text-fg-faint">
          分支 <span className="font-mono text-fg-muted">{workspace.branch}</span>
        </p>
        <p className="m-0 text-fg-faint">
          基线 <span className="font-mono text-fg-muted">{workspace.baseCommit.slice(0, 7)}</span>
        </p>
      </div>
      <PopItem
        disabled={blocked}
        {...(!reclaimed && running ? { hint: "任务运行中" } : {})}
        onClick={() => {
          setBusy(true);
          void (reclaimed ? onRestore() : onReclaim()).finally(() => {
            setBusy(false);
            close();
          });
        }}
      >
        {reclaimed ? "恢复工作目录" : "回收工作目录"}
      </PopItem>
    </>
  );
}

/**
 * The right pane's toggle. Shell pins it to the window's right edge, so opening
 * the pane does not carry it left with the conversation column.
 */
export function RightPaneToggle({
  open,
  pending,
  onToggle,
  className,
}: {
  open: boolean;
  pending: number;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label="右栏"
      title="右栏 ⌘J"
      onClick={onToggle}
      className={cn(STRIP_ICON_BUTTON, "relative", className)}
    >
      <PanelRight className="size-lg" />
      {pending > 0 && (
        <span className="-top-3xs -right-3xs absolute grid h-md min-w-md place-items-center rounded-full bg-brand px-3xs font-bold font-mono text-2xs text-brand-fg">
          {pending}
        </span>
      )}
    </button>
  );
}

/**
 * The task's top strip, on the same line as the sidebar's: the title, the
 * worktree glyph that opens 工作目录, and how the task was wound up. It doubles
 * as the window's title bar, so it drags the window. The right pane's toggle is
 * not here — it is pinned to the window's right edge. When the pane is closed
 * that edge is this strip, so a gap the size of the button is left for it.
 * 分支 and 运行位置 are under the composer, 停止 is the composer's send button,
 * 模型 and 思考 are in the composer — none of them has a second copy here.
 */
export function TaskHeader({
  thread,
  leftOpen,
  rightOpen,
  onReclaimWorkspace,
  onRestoreWorkspace,
  onToggleLeft,
}: {
  thread: ThreadSummary;
  leftOpen: boolean;
  rightOpen: boolean;
  onReclaimWorkspace: () => Promise<void>;
  onRestoreWorkspace: () => Promise<void>;
  onToggleLeft: () => void;
}) {
  const workspace = thread.workspace;

  return (
    <TopStrip
      leftOpen={leftOpen}
      onToggleLeft={onToggleLeft}
      end={rightOpen ? undefined : <span aria-hidden className="size-xl" />}
    >
      {/* Plain text, not a control: this strip is the window's title bar, so the
          title drags the window and a double-click zooms it. 重命名 is in the
          task's row menu, where Cursor keeps it. */}
      <span title={thread.title} className="min-w-0 max-w-[48ch] shrink truncate px-2xs text-body text-fg">
        {thread.title}
      </span>

      {workspace != null && (
        <Popover
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label="工作目录"
              title={workspace.reclaimed === true ? `${workspace.branch} · 已回收` : workspace.branch}
              className={cn(STRIP_ICON_BUTTON, workspace.reclaimed === true && "opacity-50")}
            >
              <GitFork className="size-md" />
            </button>
          )}
        >
          {(close) => (
            <WorkspaceMenu
              workspace={workspace}
              running={thread.status === "running"}
              onReclaim={onReclaimWorkspace}
              onRestore={onRestoreWorkspace}
              close={close}
            />
          )}
        </Popover>
      )}

      <OutcomeBadge outcome={thread.outcome} pr={thread.pr} className="max-w-[24ch]" />
    </TopStrip>
  );
}
