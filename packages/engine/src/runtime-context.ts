import type { ModelMessage } from "ai";

const PREFIX = "Vgent runtime state snapshot (replaces earlier runtime state snapshots; not a new user request; verify evidence and follow the latest user corrections):\n";

/**
 * A task-state snapshot an older build appended to the history. Nothing adds
 * them any more, but a saved compaction can still hold some, and a protocol
 * without mid-conversation system messages rejects them.
 */
export function isRuntimeContext(message: ModelMessage): boolean {
  return message.role === "system" && typeof message.content === "string" && message.content.startsWith(PREFIX);
}
