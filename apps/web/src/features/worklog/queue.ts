import { isToolUIPart, type UIMessage } from "ai";
import { describeTool } from "./toolMeta";
import { approvalAnchor, isOpenApproval, isOpenQuestion, questionAnchor } from "./turns";
import type { AskUserQuestionsInput } from "@/lib/types";
import { oneLine } from "@/lib/format";

export interface QueueItem {
  kind: "approval" | "question";
  anchor: string;
  label: string;
  mono: boolean;
}

/** Everything in the current thread that is waiting on the human. */
export function pendingQueue(messages: readonly UIMessage[]): QueueItem[] {
  const items: QueueItem[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (isOpenApproval(part)) {
        const display = describeTool(part);
        items.push({
          kind: "approval",
          anchor: approvalAnchor(part.toolCallId),
          label: `${display.verb} ${display.target}`.trim(),
          mono: true,
        });
      } else if (isOpenQuestion(part)) {
        const input = part.input as AskUserQuestionsInput | undefined;
        items.push({
          kind: "question",
          anchor: questionAnchor(part.toolCallId),
          label: oneLine(input?.questions?.[0]?.question ?? "等待回答", 60),
          mono: false,
        });
      }
    }
  }
  return items;
}
