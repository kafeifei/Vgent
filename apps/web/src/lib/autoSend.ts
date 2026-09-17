import { isToolUIPart, type UIMessage } from "ai";

/**
 * Whether the chat should auto-send its next request, reimplementing
 * `lastAssistantMessageIsCompleteWithApprovalResponses` and
 * `lastAssistantMessageIsCompleteWithToolCalls` from `ai` (see
 * `node_modules/ai/dist/index.js` around `lastAssistantMessageIsComplete...`)
 * with one change: tool parts still in `input-streaming` are ignored.
 *
 * Claude Code can issue two tool calls in a single step (e.g. `edit` +
 * `write`). The harness pauses for approval on the first one while the
 * second tool part is still `input-streaming` — its `tool-input-available`
 * chunk only arrives after the first approval is resolved. The SDK's
 * predicates require *every* tool part of the last step to have reached a
 * terminal state, so that trailing `input-streaming` part blocks auto-send
 * forever: the user approves, the card disappears, and nothing is sent
 * because the thread never leaves `awaiting-approval`. The server side
 * already tolerates this — `convertToModelMessages` drops `input-streaming`
 * parts — so once the resolved parts satisfy either rule, it's safe to send.
 */
export function shouldSendAutomatically({ messages }: { messages: UIMessage[] }): boolean {
  const message = messages[messages.length - 1];
  if (!message) return false;
  if (message.role !== "assistant") return false;

  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) => (part.type === "step-start" ? index : lastIndex),
    -1,
  );
  const lastStepToolParts = message.parts
    .slice(lastStepStartIndex + 1)
    .filter(isToolUIPart)
    .filter((part) => part.state !== "input-streaming");

  const approvalRule =
    lastStepToolParts.filter((part) => part.state === "approval-responded").length > 0 &&
    lastStepToolParts.every(
      (part) =>
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied" ||
        part.state === "approval-responded",
    );

  const toolCallParts = lastStepToolParts.filter((part) => !part.providerExecuted);
  const toolCallsRule =
    toolCallParts.length > 0 &&
    toolCallParts.every((part) => part.state === "output-available" || part.state === "output-error");

  return approvalRule || toolCallsRule;
}
