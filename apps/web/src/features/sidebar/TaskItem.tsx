import { useChat } from "@ai-sdk/react";
import type { Chat } from "@ai-sdk/react";
import { isToolUIPart, type UIMessage } from "ai";
import { relativeTime } from "@/lib/format";
import type { ThreadStatus, ThreadSummary } from "@/lib/types";
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

export function TaskItem({
  thread,
  selected,
  rail,
  chat,
  onSelect,
}: {
  thread: ThreadSummary;
  selected: boolean;
  rail: boolean;
  /** Only supplied for running threads, so idle ones cost nothing. */
  chat: Chat<UIMessage> | undefined;
  onSelect: () => void;
}) {
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

  return (
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
        </span>
      )}
    </button>
  );
}
