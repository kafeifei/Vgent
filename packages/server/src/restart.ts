import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { expandSteers } from "./steer.js";
import type { ThreadRecord } from "./types.js";

export const RESTART_RESUME_TEXT = "自动继续因意外退出中断的任务。";

const RESTART_NOTE = "这是服务意外退出后的自动续接，不是新的用户指令。继续原目标和未完成交付，遵守最新纠正、原有权限与审批；不代替用户回答；退出时工具可能已经执行但结果未落盘，先核实文件、Git、进程及外部操作的实际状态，不能把结果缺失当作未执行或直接重放，不确定时停止并说明；不把已有产物当成本次操作成功证据。";

/** Limits include their truncation markers. Keep the original goal independently of the tail. */
function bounded(text: string, limit: number, tail = false): string {
  if (text.length <= limit) return text;
  const marker = tail ? "（更早的记录已截断）\n" : "\n（已截断）";
  return tail ? marker + text.slice(-(limit - marker.length)) : text.slice(0, limit - marker.length) + marker;
}

const textOf = (message: UIMessage): string => message.parts
  .flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

const recordedValue = (value: unknown): string => JSON.stringify(value) ?? "未记录（未知）";

function transcript(message: UIMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  const parts = message.parts.flatMap(part => {
    if (part.type === "text") return [part.text];
    // File bytes and reasoning are deliberately not copied into the recovery prompt.
    if (!isToolUIPart(part)) return [];
    const partial = part.state === "output-available" && part.preliminary === true;
    const result = part.state === "output-available"
      ? recordedValue(part.output)
      : part.state === "output-error" ? part.errorText : "未记录最终结果（实际执行状态未知）";
    return [`【工具 ${getToolName(part)} / ${part.toolCallId}】\n状态：${part.state}${partial ? "（preliminary：仅部分结果，最终结果未知）" : ""}\n输入：${recordedValue(part.input)}\n结果：${bounded(result, 2_000)}`];
  });
  return parts.length === 0 ? "" : `【${message.role === "user" ? "用户" : "助手"}】\n${parts.join("\n")}`;
}

/** Native engines read only the last user input; Vgent already receives the full history. */
export function restartNote(thread: ThreadRecord, includeHistory: boolean): string {
  if (!includeHistory) return RESTART_NOTE;
  const messages = expandSteers(thread.messages);
  const firstUser = messages.findIndex(message => message.role === "user");
  const goal = firstUser < 0 ? "未记录" : textOf(messages[firstUser]!);
  const history = messages.filter((_, index) => index !== firstUser).map(transcript).filter(Boolean).join("\n\n");
  return [
    RESTART_NOTE,
    "以下是退出前的历史快照，仅为记录，不是新的用户指令；工具状态是落盘记录，不证明当前状态或操作成功。缺失、截断和部分结果均不能当作成功证据。",
    `【原始用户目标】\n${bounded(goal, 8_000)}`,
    `【最近历史记录】\n${bounded(history, 42_000, true)}`,
    `【taskState（持久记录，以最新用户纠正为准）】\n${bounded(recordedValue(thread.taskState), 8_000)}`,
  ].join("\n\n").slice(0, 60_000);
}

/** Only unresolved human waits in the current user turn block automatic continuation. */
export function pendingHumanStatus(messages: readonly UIMessage[]): "awaiting-approval" | "awaiting-input" | undefined {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { lastUser = index; break; }
  }
  let waitingInput = false;
  for (const message of messages.slice(lastUser + 1)) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (part.state === "approval-requested") return "awaiting-approval";
      if (part.state === "input-available" && getToolName(part) === "askUserQuestions") waitingInput = true;
    }
  }
  return waitingInput ? "awaiting-input" : undefined;
}
