import { memo, useRef, useState, type RefObject } from "react";
import { GitFork, MoreHorizontal } from "lucide-react";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { PopItem, Popover } from "@/components/Popover";
import { shortTime } from "@/lib/format";
import { isImeKeyEvent } from "@/lib/ime";
import { LIVE_STATUSES, TRANSITION_LABELS, type ThreadStatus, type ThreadSummary, type ThreadTransition } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UncommittedConfirm, useUncommittedGate } from "@/features/workspace/UncommittedConfirm";
import { DeleteConfirm, useDeleteConfirm } from "./DeleteConfirm";
import { useMinute } from "./grouping";

/** What each colour of the dot means, for whoever cannot see the colour. */
export const STATUS_NAMES: Record<ThreadStatus, string> = {
  idle: "空闲",
  running: "运行中",
  "awaiting-approval": "等待审批",
  "awaiting-input": "等待回答",
  interrupted: "已中断",
  error: "失败",
};

/** Shape, not just colour: 「等人」 is a hollow ring, 「在跑 / 结束」 is a solid dot. */
export function StatusDot({ status }: { status: ThreadStatus }) {
  const base = "size-xs flex-none rounded-full";
  const name = { role: "img", "aria-label": STATUS_NAMES[status] } as const;
  if (status === "running") return <span {...name} className={cn(base, "animate-breathe bg-brand")} />;
  if (status === "awaiting-approval") return <span {...name} className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-warning)]")} />;
  if (status === "awaiting-input") return <span {...name} className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-info)]")} />;
  if (status === "error" || status === "interrupted") return <span {...name} className={cn(base, "bg-danger")} />;
  return <span {...name} className={cn(base, "bg-fg-faint")} />;
}

/**
 * The row's `now` / `5m` stamp. The row is memoised on its task, which does not
 * change while the task sits idle, so the stamp follows the sidebar's minute
 * clock by itself — only it renders again when the minute turns.
 */
function Stamp({ at }: { at: string }) {
  useMinute();
  return <span>{shortTime(at)}</span>;
}

export type RowMenuActions = {
  archived: boolean;
  unread: boolean;
  /** Archiving reclaims the worktree, so a turn that still owns it blocks it. Deleting stops the run first, so it does not. */
  live: boolean;
  /** The last 归档 / 取消归档 is still moving the worktree; another waits for it. */
  transition: ThreadTransition | undefined;
  /** A worktree still on disk: archiving or deleting it asks about uncommitted changes first. */
  worktree: boolean;
  /** `preserveChanges`: the user confirmed the worktree's uncommitted changes go along. */
  onArchive: (archived: boolean, preserveChanges?: boolean) => void;
  onCheckUncommitted: () => Promise<number>;
  onUnread: (unread: boolean) => void;
  onDelete: () => void;
  /** Turns the row's title into a field. */
  onStartRename: () => void;
};

/**
 * What the row's menu holds: 重命名, 标为未读 / 已读, 归档 / 取消归档 and a two-step
 * 删除任务. Each answers to a letter while the menu is open (R / U / A / D), and the
 * second step of deleting to ↵ — two different keys, so a double tap deletes
 * nothing. 归档 of a worktree with uncommitted changes opens a separate dialog;
 * 删除 of one says, in its second step, how many files would be lost with it.
 * 归档 is not listed while it cannot be done (a turn is live, the worktree is
 * moving) rather than listed dead with a reason. Mounted per opening, so the
 * menu never reopens on the delete confirmation.
 */
export function RowMenuItems({
  archived,
  unread,
  live,
  transition,
  worktree,
  close,
  onArchive,
  onCheckUncommitted,
  onUnread,
  onDelete,
  onStartRename,
  onConfirmArchive,
}: RowMenuActions & { close: () => void; onConfirmArchive: (files: number | undefined) => void }) {
  const archive = useUncommittedGate(onCheckUncommitted, () => {
    close();
    onArchive(true, false);
  }, (files) => {
    close();
    onConfirmArchive(files);
  });
  const remove = useDeleteConfirm(worktree, onCheckUncommitted);

  if (typeof remove.phase === "object") {
    return (
      <DeleteConfirm
        files={remove.phase.files}
        onConfirm={() => {
          close();
          onDelete();
        }}
        onCancel={remove.cancel}
      />
    );
  }

  return (
    <>
      <PopItem
        shortcut="r"
        onClick={() => {
          close();
          onStartRename();
        }}
      >
        重命名
      </PopItem>
      <PopItem
        shortcut="u"
        onClick={() => {
          close();
          onUnread(!unread);
        }}
      >
        {unread ? "标为已读" : "标为未读"}
      </PopItem>
      {!live && transition == null && (
        <PopItem
          shortcut="a"
          disabled={archive.phase === "checking"}
          onClick={() => {
            if (!archived && worktree) {
              archive.start();
              return;
            }
            close();
            onArchive(!archived);
          }}
        >
          {archived ? "取消归档" : "归档"}
        </PopItem>
      )}
      <PopItem shortcut="d" disabled={remove.phase === "checking"} onClick={remove.start}>
        删除任务…
      </PopItem>
    </>
  );
}

/** The row's own menu, behind ⋯ and behind a right-click on the row. */
function RowMenu({ openRef, ...actions }: RowMenuActions & { openRef: RefObject<(() => void) | null> }) {
  const [confirmation, setConfirmation] = useState<{ files: number | undefined } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <Popover
        align="end"
        openRef={openRef}
        trigger={(props) => (
          <button
            type="button"
            aria-label="任务操作"
            {...props}
            ref={(node) => { props.ref.current = node; triggerRef.current = node; }}
            className="absolute top-1/2 right-2xs grid size-xl -translate-y-1/2 place-items-center rounded-md text-fg-muted opacity-0 hover:bg-bg-active hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100 group-hover:opacity-100"
          >
            <MoreHorizontal className="size-md" />
          </button>
        )}
      >
        {(close) => <RowMenuItems {...actions} close={close} onConfirmArchive={(files) => setConfirmation({ files })} />}
      </Popover>
      {confirmation != null && (
        <UncommittedConfirm
          files={confirmation.files}
          verb="归档"
          comeBack="取消归档"
          returnFocusRef={triggerRef}
          onConfirm={() => {
            setConfirmation(null);
            actions.onArchive(true, true);
          }}
          onCancel={() => setConfirmation(null)}
        />
      )}
    </>
  );
}

export interface TaskItemProps {
  thread: ThreadSummary;
  selected: boolean;
  /**
   * The row's actions take the task's id themselves, so the list can hand every
   * row the same functions — and a row whose task did not change is not rendered
   * again when another one does.
   */
  onSelect: (threadId: string) => void;
  onArchive: (threadId: string, archived: boolean, preserveChanges?: boolean) => void;
  onCheckUncommitted: (threadId: string) => Promise<number>;
  onUnread: (threadId: string, unread: boolean) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
}

export const TaskItem = memo(function TaskItem({
  thread,
  selected,
  onSelect,
  onArchive,
  onCheckUncommitted,
  onUnread,
  onDelete,
  onRename,
}: TaskItemProps) {
  const openMenu = useRef<(() => void) | null>(null);
  /** The title being typed, while the row is being renamed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const commitRename = (): void => {
    const next = renaming?.trim() ?? "";
    if (next !== "" && next !== thread.title) onRename(thread.id, next);
    setRenaming(null);
  };
  const unread = thread.unread === true;
  const state =
    thread.workspaceState === "creating"
      ? "创建 worktree 中"
      : thread.workspaceState === "failed"
        ? "worktree 创建失败"
        : thread.status === "awaiting-approval"
          ? "等待审批"
          : thread.status === "awaiting-input"
            ? "等待回答"
            : thread.status === "error"
              ? "失败"
              : thread.status === "interrupted"
                ? "已中断"
                : undefined;
  // The gutter left of the title is where a row says it needs a look. A turn in
  // flight or parked on the human shows its state for as long as that lasts; one
  // that has settled — done, failed, stopped — is marked only until it is read,
  // so opening a failed task clears its red dot like any other unread one.
  const settled = thread.status === "idle" || thread.status === "error" || thread.status === "interrupted";
  const marked = settled ? unread : true;
  const archived = thread.archivedAt != null;

  return (
    <div
      className="group relative"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu.current?.();
      }}
    >
      {renaming != null && (
        <input
          autoFocus
          value={renaming}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setRenaming(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (isImeKeyEvent(event)) return;
            if (event.key === "Enter") commitRename();
            if (event.key === "Escape") setRenaming(null);
          }}
          className="absolute inset-y-0 right-0 left-row-indent z-1 min-w-0 rounded-md border border-border-strong bg-bg-elevated px-2xs text-body outline-none"
        />
      )}
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        aria-current={selected}
        title={state != null ? `${thread.title} · ${state}` : thread.title}
        className={cn(
          "relative flex h-row w-full items-center gap-xs rounded-md pr-xs pl-row-indent text-left text-body hover:bg-bg-hover",
          selected && "bg-bg-active hover:bg-bg-active",
        )}
      >
        {marked && (
          <span className="absolute left-0 grid h-full w-row-indent place-items-center">
            {settled ? (
              <span
                aria-label={thread.status === "error" ? "失败，未读" : "未读"}
                title={thread.status === "error" ? "失败，未读" : "未读"}
                className={cn("size-xs flex-none rounded-full", thread.status === "error" ? "bg-danger" : "bg-info")}
              />
            ) : (
              <StatusDot status={thread.status} />
            )}
          </span>
        )}
        <span className={cn("min-w-0 flex-1 truncate", unread && "font-medium", archived && "text-fg-faint")}>
          {thread.workspaceState != null ? `${thread.title} · ${state}` : thread.title}
        </span>
        <OutcomeBadge outcome={thread.outcome} pr={thread.pr} />
        {/* The stamp gives way to the row's menu on hover, so the two never fight for the corner. */}
        <span className="flex flex-none items-center gap-xs text-fg-faint text-sm group-hover:invisible group-has-[[aria-expanded=true]]:invisible">
          {(thread.workspace != null || thread.workspaceState != null) && <GitFork className="size-md" aria-label="在 worktree 里" />}
          {thread.transition != null ? (
            <Shimmer as="span">{TRANSITION_LABELS[thread.transition]}</Shimmer>
          ) : (
            <Stamp at={thread.updatedAt} />
          )}
        </span>
      </button>
      <RowMenu
        archived={archived}
        unread={unread}
        live={(LIVE_STATUSES as readonly string[]).includes(thread.status)}
        transition={thread.transition}
        worktree={thread.workspace != null && thread.workspace.reclaimed !== true}
        openRef={openMenu}
        onArchive={(archived, preserveChanges) => onArchive(thread.id, archived, preserveChanges)}
        onCheckUncommitted={() => onCheckUncommitted(thread.id)}
        onUnread={(unread) => onUnread(thread.id, unread)}
        onDelete={() => onDelete(thread.id)}
        onStartRename={() => setRenaming(thread.title)}
      />
    </div>
  );
});
