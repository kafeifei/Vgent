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
