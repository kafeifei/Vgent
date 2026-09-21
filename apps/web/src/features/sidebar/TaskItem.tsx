import { useRef, useState, type RefObject } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { isToolUIPart, type UIMessage } from "ai";
import { GitFork, MoreHorizontal } from "lucide-react";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { shortTime } from "@/lib/format";
import { isImeKeyEvent } from "@/lib/ime";
import { CHAT_THROTTLE_MS } from "@/lib/threadChats";
import { LIVE_REASON, LIVE_STATUSES, type ThreadStatus, type ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { describeTool } from "@/features/worklog/toolMeta";

/** Shape, not just colour: 「等人」 is a hollow ring, 「在跑 / 结束」 is a solid dot. */
export function StatusDot({ status }: { status: ThreadStatus }) {
  const base = "size-xs flex-none rounded-full";
  if (status === "running") return <span className={cn(base, "animate-breathe bg-brand")} />;
  if (status === "awaiting-approval") return <span className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-warning)]")} />;
  if (status === "awaiting-input") return <span className={cn(base, "shadow-[inset_0_0_0_2px_var(--color-info)]")} />;
  if (status === "error" || status === "interrupted") return <span className={cn(base, "bg-danger")} />;
  return <span className={cn(base, "bg-fg-faint")} />;
}

/** The last tool call the live chat produced, e.g. `读取 src/x.ts` / `$ pnpm test`. */
function currentAction(messages: readonly UIMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message == null || message.role !== "assistant") continue;
    for (let part = message.parts.length - 1; part >= 0; part -= 1) {
      const candidate = message.parts[part];
      if (candidate == null || !isToolUIPart(candidate)) continue;
      const display = describeTool(candidate);
      return `${display.verb} ${display.target}`.trim();
    }
  }
  return undefined;
}

/** A running task's row: its title, with the current action as the hover text. */
function LiveTitle({ chat, title }: { chat: Chat<UIMessage>; title: string }) {
  const { messages } = useChat({ chat, throttle: CHAT_THROTTLE_MS });
  return <span title={currentAction(messages) ?? "运行中"}>{title}</span>;
}

type RowMenuActions = {
  archived: boolean;
  unread: boolean;
  /** Archiving reclaims the worktree, so a turn that still owns it blocks it. Deleting stops the run first, so it does not. */
  live: boolean;
  onArchive: (archived: boolean) => void;
  onUnread: (unread: boolean) => void;
  onDelete: () => void;
  /** Turns the row's title into a field. */
  onStartRename: () => void;
};

/**
 * What the row's menu holds: 重命名, 标为未读 / 已读, 归档 / 取消归档 and a two-step
 * 删除任务. Each answers to a letter while the menu is open (R / U / A / D), and the
 * second step of deleting to ↵ — two different keys, so a double tap deletes
 * nothing. Mounted per opening, so the menu never reopens on that second step.
 */
function RowMenuItems({
  archived,
  unread,
  live,
  close,
  onArchive,
  onUnread,
  onDelete,
  onStartRename,
}: RowMenuActions & { close: () => void }) {
  const [confirming, setConfirming] = useState(false);

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
        disabled={live}
        {...(live ? { hint: "进行中", title: LIVE_REASON } : {})}
        onClick={() => {
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
  chat,
  onSelect,
  onArchive,
  onUnread,
  onDelete,
  onRename,
}: {
  thread: ThreadSummary;
  selected: boolean;
  /** Only supplied for running threads, so idle ones cost nothing. */
  chat: Chat<UIMessage> | undefined;
  onSelect: () => void;
  onArchive: (archived: boolean) => void;
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
    thread.status === "awaiting-approval"
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
          {thread.status === "running" && chat != null ? <LiveTitle chat={chat} title={thread.title} /> : thread.title}
        </span>
        <OutcomeBadge outcome={thread.outcome} pr={thread.pr} />
        {/* The stamp gives way to the row's menu on hover, so the two never fight for the corner. */}
        <span className="flex flex-none items-center gap-xs text-fg-faint text-sm group-hover:invisible group-has-[[aria-expanded=true]]:invisible">
          {thread.workspace != null && <GitFork className="size-md" aria-label="在 worktree 里" />}
          <span>{shortTime(thread.updatedAt)}</span>
        </span>
      </button>
      <RowMenu
        archived={archived}
        unread={unread}
        live={(LIVE_STATUSES as readonly string[]).includes(thread.status)}
        openRef={openMenu}
        onArchive={onArchive}
        onUnread={onUnread}
        onDelete={onDelete}
        onStartRename={() => setRenaming(thread.title)}
      />
    </div>
  );
}
