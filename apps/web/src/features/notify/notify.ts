import { isToolUIPart, type UIMessage } from "ai";
import { oneLine } from "@/lib/format";
import { LIVE_STATUSES, type Settings, type ThreadStatus, type ThreadSummary } from "@/lib/types";
import { describeTool } from "@/features/worklog/toolMeta";

/**
 * 系统通知的判断，全部在这里，而且是纯函数：派完活人就切走了，把「该不该叫他
 * 回来」写成可测的一步，比在 effect 里边跑边想安全得多。
 */

/** Why we are calling the user back. */
export type NotifyReason = "done" | "error" | "approval" | "input";

export interface NotifyDecision {
  threadId: string;
  reason: NotifyReason;
  /** A notification is about one task, so its title is the task's. */
  title: string;
  body: string;
}

/** What a turn can settle into that is worth a notification. Anything else (中断) is not. */
const REASONS: Partial<Record<ThreadStatus, NotifyReason>> = {
  idle: "done",
  error: "error",
  "awaiting-approval": "approval",
  "awaiting-input": "input",
};

const TITLE_MAX = 60;
const ERROR_MAX = 60;
const DETAIL_MAX = 40;

function bodyFor(reason: NotifyReason, error: string | undefined, detail: string | undefined): string {
  if (reason === "done") return "已完成";
  if (reason === "input") return "等你回答";
  if (reason === "error") {
    const text = oneLine(error ?? "", ERROR_MAX);
    return text === "" ? "出错了" : `出错了：${text}`;
  }
  const text = oneLine(detail ?? "", DETAIL_MAX);
  return text === "" ? "等你审批" : `等你审批：${text}`;
}

/**
 * 「系统通知」 defaults to on, so only an explicit `false` turns it off. Settings
 * we have not received yet count as off: the first snapshot never notifies
 * anyway, and guessing on a null would be guessing.
 */
export const notificationsEnabled = (settings: Pick<Settings, "systemNotifications"> | null): boolean =>
  settings != null && settings.systemNotifications !== false;

/**
 * One transition → at most one notification.
 *
 * The caller keeps the ledger (the status each task was last seen in) and calls
 * this once per task per snapshot; `previous` being absent — a fresh page, a
 * task we are seeing for the first time — never notifies, which is also what
 * keeps a stream reconnect quiet. Only a turn that was the engine's move and
 * then stopped being it counts, so a task sitting idle forever says nothing.
 */
export function decideNotification(input: {
  thread: Pick<ThreadSummary, "id" | "title" | "status"> & { error?: string | undefined };
  /** The status this client last saw for the task. */
  previous: ThreadStatus | undefined;
  /** 设置里的「系统通知」. */
  enabled: boolean;
  /** `!document.hidden && document.hasFocus()` — a window the user is looking at needs no notification. */
  focused: boolean;
  /** What 等你审批 is about: the tool or command, when this client can see it. */
  detail?: string | undefined;
}): NotifyDecision | undefined {
  const { thread, previous, enabled, focused, detail } = input;
  if (!enabled || focused) return undefined;
  if (previous == null || previous === thread.status) return undefined;
  if (!(LIVE_STATUSES as readonly string[]).includes(previous)) return undefined;
  const reason = REASONS[thread.status];
  if (reason == null) return undefined;
  return {
    threadId: thread.id,
    reason,
    title: oneLine(thread.title, TITLE_MAX),
    body: bodyFor(reason, thread.error, detail),
  };
}

/**
 * What the task is waiting to be allowed to do, e.g. `$ pnpm test` — read off
 * the last assistant message this window happens to have loaded. `undefined`
 * whenever it cannot be known, and the notification then just says 等你审批.
 */
export function pendingApprovalLabel(message: UIMessage | undefined): string | undefined {
  if (message == null || message.role !== "assistant") return undefined;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part == null || !isToolUIPart(part) || part.state !== "approval-requested") continue;
    const display = describeTool(part);
    const label = `${display.verb} ${display.target}`.trim();
    return label === "" ? undefined : label;
  }
  return undefined;
}
