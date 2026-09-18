import { getToolName, isDynamicToolUIPart, isToolUIPart, type UIMessage } from "ai";

/**
 * Approval ids the global 「一直允许」 list already answers.
 *
 * This runs client-side for *every* engine on purpose: only the in-house engine
 * decides approvals in our own code (see `decideApproval`), while the harness
 * engines decide inside themselves and cannot be told about the list.
 * Answering here also covers the rest of a turn whose runner was built before
 * the tool was added.
 *
 * Pure so the effect that posts the responses stays a loop over these ids.
 */
export function pendingAutoApprovals(
  messages: readonly UIMessage[],
  alwaysAllow: readonly string[] | undefined,
): string[] {
  if (alwaysAllow == null || alwaysAllow.length === 0) return [];
  const allowed = new Set(alwaysAllow);
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) continue;
      if (part.state !== "approval-requested") continue;
      if (allowed.has(getToolName(part))) ids.push(part.approval.id);
    }
  }
  return ids;
}
