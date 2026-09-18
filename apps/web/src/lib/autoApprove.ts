import { isAllowlisted } from "@vgent/engine/allowlist";
import { getToolName, isDynamicToolUIPart, isToolUIPart, type UIMessage } from "ai";

/**
 * Approval ids the global 「一直允许」 list already answers.
 *
 * This runs client-side for *every* engine on purpose: only the in-house engine
 * decides approvals in our own code (see `decideApproval`), while the harness
 * engines decide inside themselves and cannot be told about the list.
 * Answering here also covers the rest of a turn whose runner was built before
 * the entry was added.
 *
 * The decision itself is `@vgent/engine/allowlist` — the very function the
 * engine runs — so a `bash(git)` entry means exactly the same thing on both
 * sides. That module is dependency-free for this reason.
 *
 * Pure so the effect that posts the responses stays a loop over these ids.
 */
export function pendingAutoApprovals(
  messages: readonly UIMessage[],
  allowlist: readonly string[] | undefined,
): string[] {
  if (allowlist == null || allowlist.length === 0) return [];
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part) && !isDynamicToolUIPart(part)) continue;
      if (part.state !== "approval-requested") continue;
      if (isAllowlisted({ toolName: getToolName(part), input: part.input, allowlist })) ids.push(part.approval.id);
    }
  }
  return ids;
}
