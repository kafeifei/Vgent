import type { UIMessage } from "ai";
import type { ThreadMessageMetadata } from "./types";

/** Older builds incorrectly marked a native request as an already completed summary. */
export function isCompactionRequest(message: UIMessage | undefined): boolean {
  if (message?.role !== "user") return false;
  const metadata = message.metadata as ThreadMessageMetadata | undefined;
  return metadata?.compactRequested != null || (
    metadata?.compacted != null && message.parts.length === 1 &&
    message.parts[0]?.type === "text" && message.parts[0].text === "/compact"
  );
}

/** Claude's native command can finish successfully without an assistant reply or usage. */
export function completedCompactionRequest(message: UIMessage | undefined): boolean {
  if (!isCompactionRequest(message)) return false;
  const metadata = message!.metadata as ThreadMessageMetadata;
  return metadata.turnEnd == null && metadata.run?.endedAt != null &&
    metadata.run.stopReason === "response" && metadata.run.finishReason === "stop";
}

/** How the server leads the summary in for the model (`COMPACTION_PREFIX` there); the pane shows what follows. */
const SUMMARY_LEAD_IN = "上下文已压缩，以下是之前对话的摘要：";

/**
 * The marker the in-house engine's 压缩 leaves: a user message carrying the
 * summary. Everything before it stays in the log; the model reads on from it.
 */
export function isCompactionMarker(message: UIMessage | undefined): boolean {
  if (message?.role !== "user" || isCompactionRequest(message)) return false;
  return (message.metadata as ThreadMessageMetadata | undefined)?.compacted != null;
}

/** The summary a marker carries, without the lead-in. */
export function compactionSummary(message: UIMessage): string {
  const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text.startsWith(SUMMARY_LEAD_IN) ? text.slice(SUMMARY_LEAD_IN.length).trim() : text.trim();
}

/**
 * What the model reads from the latest marker on — its summary, the turns it
 * kept word for word, what came after — as the server assembles it
 * (`sinceCompaction` there). Undefined when nothing was compacted.
 */
export function sinceCompaction(messages: readonly UIMessage[]): UIMessage[] | undefined {
  const at = messages.findLastIndex(isCompactionMarker);
  if (at < 0) return undefined;
  const marker = messages[at]!;
  const keptFrom = (marker.metadata as ThreadMessageMetadata).compacted?.keptFrom;
  const from = keptFrom == null ? -1 : messages.findIndex((message) => message.id === keptFrom);
  const kept = from >= 0 && from < at ? messages.slice(from, at).filter((message) => !isCompactionMarker(message)) : [];
  return [marker, ...kept, ...messages.slice(at + 1)];
}
