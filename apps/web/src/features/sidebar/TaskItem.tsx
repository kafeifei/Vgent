import { useRef, useState, type RefObject } from "react";
import { GitFork, MoreHorizontal } from "lucide-react";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { shortTime } from "@/lib/format";
import { isImeKeyEvent } from "@/lib/ime";
import { LIVE_REASON, LIVE_STATUSES, TRANSITION_LABELS, type ThreadStatus, type ThreadSummary, type ThreadTransition } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UncommittedConfirm, useUncommittedGate } from "@/features/workspace/UncommittedConfirm";

/** Shape, not just colour: 「等人」 is a hollow ring, 「在跑 / 结束」 is a solid dot. */
export function StatusDot({ status }: { status: ThreadStatus }) {
  const base = "size-xs flex-none rounded-full";
  if (status === "running") return <span className={cn(base, "animate-breathe bg-brand")} />;
  if (status === "awaiting-approval") return <span className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-warning)]")} />;
  if (status === "awaiting-input") return <span className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-info)]")} />;
  if (status === "error" || status === "interrupted") return <span className={cn(base, "bg-danger")} />;
  return <span className={cn(base, "bg-fg-faint")} />;
}

type RowMenuActions = {
  archived: boolean;
  unread: boolean;
  /** Archiving reclaims the worktree, so a turn that still owns it blocks it. Deleting stops the run first, so it does not. */
  live: boolean;
  /** The last 归档 / 取消归档 is still moving the worktree; another waits for it. */
  transition: ThreadTransition | undefined;
  /** A worktree still on disk: archiving it asks about uncommitted changes first. */
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
 * nothing. 归档 of a worktree with uncommitted changes gets the same second
 * step. Mounted per opening, so the menu never reopens on that second step.
 */
function RowMenuItems({
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
}: RowMenuActions & { close: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const archive = useUncommittedGate(onCheckUncommitted, (preserveChanges) => {
    close();
    onArchive(true, preserveChanges);
  });

  if (typeof archive.phase === "object") {
    return (
      <UncommittedConfirm
        files={archive.phase.files}
        verb="归档"
        comeBack="取消归档"
        onConfirm={() => {
          close();
          onArchive(true, true);
        }}
        onCancel={archive.cancel}
      />
    );
  }

  if (confirming) {
    return (
      <>
        <PopTitle>删除这个任务？</PopTitle>
        <p className="m-0 px-xs pb-2xs text-fg-muted text-xs leading-snug">
          会删掉对话记录、worktree 和快照。分支上如果有提交会保留下来。
        </p>
        <PopItem
          shortcut="Enter"
          onClick={() => {
            close();
            onDelete();
          }}
        >
          <span className="text-danger">确认删除</span>
        </PopItem>
        <PopItem onClick={() => setConfirming(false)}>取消</PopItem>
      </>
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
      <PopItem
        shortcut="a"
        disabled={live || transition != null || archive.phase === "checking"}
        {...(transition != null ? { hint: TRANSITION_LABELS[transition] } : live ? { hint: "进行中", title: LIVE_REASON } : {})}
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
      <PopItem shortcut="d" onClick={() => setConfirming(true)}>
        删除任务…
      </PopItem>
    </>
  );
}

/** The row's own menu, behind ⋯ and behind a right-click on the row. */
function RowMenu({ openRef, ...actions }: RowMenuActions & { openRef: RefObject<(() => void) | null> }) {
  return (
    <Popover
      align="end"
      openRef={openRef}
      trigger={(props) => (
        <button
          type="button"
          aria-label="任务操作"
          {...props}
          className="absolute top-1/2 right-2xs grid size-xl -translate-y-1/2 place-items-center rounded-md text-fg-muted opacity-0 hover:bg-bg-active hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100 group-hover:opacity-100"
        >
          <MoreHorizontal className="size-md" />
        </button>
      )}
    >
      {(close) => <RowMenuItems {...actions} close={close} />}
    </Popover>
  );
}

export function TaskItem({
  thread,
  selected,
  onSelect,
  onArchive,
  onCheckUncommitted,
  onUnread,
  onDelete,
  onRename,
}: {
  thread: ThreadSummary;
  selected: boolean;
  onSelect: () => void;
  onArchive: (archived: boolean, preserveChanges?: boolean) => void;
  onCheckUncommitted: () => Promise<number>;
  onUnread: (unread: boolean) => void;
  onDelete: () => void;
  onRename: (title: string) => void;
}) {
  const openMenu = useRef<(() => void) | null>(null);
  /** The title being typed, while the row is being renamed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const commitRename = (): void => {
    const next = renaming?.trim() ?? "";
    if (next !== "" && next !== thread.title) onRename(next);
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
        onClick={onSelect}
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
            <span>{shortTime(thread.updatedAt)}</span>
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
        onArchive={onArchive}
        onCheckUncommitted={onCheckUncommitted}
        onUnread={onUnread}
        onDelete={onDelete}
        onStartRename={() => setRenaming(thread.title)}
      />
    </div>
  );
}
