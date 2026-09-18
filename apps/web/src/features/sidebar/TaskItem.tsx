import { useRef, useState, type RefObject } from "react";
import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { isToolUIPart, type UIMessage } from "ai";
import { MoreHorizontal } from "lucide-react";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { relativeTime } from "@/lib/format";
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

/** The second line of a running task, read off its live chat. */
function LiveAction({ chat }: { chat: Chat<UIMessage> }) {
  const { messages } = useChat({ chat });
  return <>{currentAction(messages) ?? "运行中"}</>;
}

/** The row's own menu: 归档 / 取消归档 and a two-step 删除任务. */
function RowMenu({
  archived,
  live,
  openRef,
  onArchive,
  onDelete,
}: {
  archived: boolean;
  /** Archiving reclaims the worktree, so a turn that still owns it blocks it. Deleting stops the run first, so it does not. */
  live: boolean;
  openRef: RefObject<(() => void) | null>;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <Popover
      align="end"
      openRef={openRef}
      trigger={(props) => (
        <button
          type="button"
          aria-label="任务操作"
          {...props}
          onClick={() => {
            setConfirming(false);
            props.onClick();
          }}
          className="absolute top-xs right-2xs grid size-lg place-items-center rounded-sm text-fg-faint opacity-0 hover:bg-bg-active hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100 group-hover:opacity-100"
        >
          <MoreHorizontal className="size-md" />
        </button>
      )}
    >
      {(close) =>
        confirming ? (
          <>
            <PopTitle>删除这个任务？</PopTitle>
            <p className="m-0 px-xs pb-2xs text-fg-muted text-xs leading-snug">
              会删掉对话记录、worktree 和快照。分支上如果有提交会保留下来。
            </p>
            <PopItem
              onClick={() => {
                close();
                onDelete();
              }}
            >
              <span className="text-danger">确认删除</span>
            </PopItem>
            <PopItem onClick={() => setConfirming(false)}>取消</PopItem>
          </>
        ) : (
          <>
            <PopItem
              disabled={live}
              {...(live ? { hint: "进行中", title: LIVE_REASON } : {})}
              onClick={() => {
                close();
                onArchive(!archived);
              }}
            >
              {archived ? "取消归档" : "归档"}
            </PopItem>
            <PopItem onClick={() => setConfirming(true)}>删除任务…</PopItem>
          </>
        )
      }
    </Popover>
  );
}

export function TaskItem({
  thread,
  selected,
  rail,
  chat,
  onSelect,
  onArchive,
  onDelete,
}: {
  thread: ThreadSummary;
  selected: boolean;
  rail: boolean;
  /** Only supplied for running threads, so idle ones cost nothing. */
  chat: Chat<UIMessage> | undefined;
  onSelect: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const openMenu = useRef<(() => void) | null>(null);
  const meta =
    thread.status === "awaiting-approval"
      ? "等待审批"
      : thread.status === "awaiting-input"
        ? "等待回答"
        : thread.status === "error"
          ? `失败 · ${relativeTime(thread.updatedAt)}`
          : thread.status === "interrupted"
            ? `已中断 · ${relativeTime(thread.updatedAt)}`
            : relativeTime(thread.updatedAt);
  const stats = thread.changeStats;

  const row = (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      title={thread.title}
      className={cn(
        "relative block w-full rounded-md py-xs pr-xs text-left hover:bg-bg-hover",
        rail ? "mb-3xs min-h-xl px-2xs" : "min-h-row-task pl-md",
        selected && "bg-bg-active",
      )}
    >
      {selected && <span className="absolute top-xs bottom-xs left-0 w-[2px] rounded-full bg-brand" />}
      <span className={cn("flex items-center gap-xs", rail && "justify-center")}>
        <StatusDot status={thread.status} />
        {!rail && <span className="min-w-0 flex-1 truncate text-sm">{thread.title}</span>}
      </span>
      {!rail && (
        <span className="mt-3xs flex items-center gap-xs pl-md text-fg-faint text-xs">
          <span className="min-w-0 flex-1 truncate">
            {thread.status === "running" && chat != null ? <LiveAction chat={chat} /> : meta}
          </span>
          <OutcomeBadge outcome={thread.outcome} pr={thread.pr} />
          {stats != null && stats.files > 0 && (
            <span className="flex flex-none gap-2xs font-mono text-2xs">
              <span className="text-diff-add-fg">+{stats.additions}</span>
              <span className="text-diff-del-fg">−{stats.deletions}</span>
            </span>
          )}
        </span>
      )}
    </button>
  );

  if (rail) return row;

  return (
    <div
      className="group relative"
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu.current?.();
      }}
    >
      {row}
      <RowMenu
        archived={thread.archivedAt != null}
        live={(LIVE_STATUSES as readonly string[]).includes(thread.status)}
        openRef={openMenu}
        onArchive={onArchive}
        onDelete={onDelete}
      />
    </div>
  );
}
