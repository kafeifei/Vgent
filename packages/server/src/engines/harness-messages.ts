import type { ModelMessage } from "ai";

/**
 * Strip the synthetic `execution-denied` tool result a *denied* approval drags
 * along, so the harness can still see the denial as an approval continuation.
 *
 * `convertToModelMessages` answers `approval: { approved: false }` with two
 * parts in the trailing `role: 'tool'` message: the `tool-approval-response`
 * itself, and a fabricated `tool-result` carrying
 * `output: { type: 'execution-denied' }`. That result is what an in-process
 * agent loop needs — it is the only thing the model ever sees about the
 * denial.
 *
 * The harness reads the same message the other way round.
 * `collectHarnessAgentToolApprovalContinuations` treats a tool result for a
 * call as proof that the call is already settled and *skips* the approval
 * response for it, so the denial never reaches `submitToolApproval` and the
 * runtime's own `canUseTool` promise is left pending: the `claude` process
 * sits there, the stream produces nothing more, and the turn hangs until it is
 * stopped by hand. An approval is unaffected — `approved: true` adds no
 * synthetic result, which is why allowing always worked.
 *
 * Dropping the result loses nothing: for a built-in tool the harness forwards
 * the denial over the bridge, and for a host tool it submits the very same
 * `execution-denied` output itself (`processPendingApprovalContinuation`).
 *
 * Only the harness engines need this. The self-built engine runs the AI SDK
 * loop in this process and must keep the synthetic result.
 */
export function stripDeniedApprovalResults(messages: ModelMessage[]): ModelMessage[] {
  const last = messages.at(-1);
  if (last?.role !== "tool") return messages;

  const deniedApprovalIds = new Set<string>();
  for (const part of last.content) {
    if (part.type === "tool-approval-response" && part.approved === false) deniedApprovalIds.add(part.approvalId);
  }
  if (deniedApprovalIds.size === 0) return messages;

  // The approval response names an approval id; the result names a tool call
  // id. Only the request the assistant issued earlier ties the two together.
  const deniedToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && deniedApprovalIds.has(part.approvalId)) deniedToolCallIds.add(part.toolCallId);
    }
  }
  if (deniedToolCallIds.size === 0) return messages;

  const content = last.content.filter(
    (part) => !(part.type === "tool-result" && part.output.type === "execution-denied" && deniedToolCallIds.has(part.toolCallId)),
  );
  if (content.length === last.content.length) return messages;
  // The approval responses themselves always survive, so the message is never
  // emptied out and the history still ends in `role: 'tool'`.
  return [...messages.slice(0, -1), { ...last, content }];
}
