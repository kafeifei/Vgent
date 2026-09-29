import type { ModelMessage } from "ai";

const PREFIX = "Vgent runtime state snapshot (replaces earlier runtime state snapshots; not a new user request; verify evidence and follow the latest user corrections):\n";

export function isRuntimeContext(message: ModelMessage): boolean {
  return message.role === "system" && typeof message.content === "string" && message.content.startsWith(PREFIX);
}

/** Append changes, rather than rewriting the instructions before the entire history. */
export function appendRuntimeContext(messages: ModelMessage[], state: string): ModelMessage[] {
  const content = PREFIX + (state || "No saved task continuation state or memory provenance.");
  if (messages.findLast(isRuntimeContext)?.content === content) return messages;
  return [...messages, { role: "system", content }];
}
