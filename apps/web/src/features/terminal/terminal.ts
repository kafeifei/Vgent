import { isToolUIPart, type UIMessage } from "ai";
import { describeTool, exitCodeOf, field, outputText, type ToolPart } from "@/features/worklog/toolMeta";

export type TerminalState = "running" | "done" | "error";

export interface TerminalEntry {
  id: string;
  command: string;
  output: string | undefined;
  state: TerminalState;
  exitCode?: number;
}

function toEntry(part: ToolPart): TerminalEntry {
  const id = part.toolCallId;
  const command = field(part.input, "command") ?? "";

  if (part.state === "output-error") {
    return { id, command, output: part.errorText, state: "error" };
  }
  if (part.state === "output-denied") {
    return { id, command, output: "用户拒绝执行", state: "error" };
  }
  if (part.state === "output-available") {
    const exitCode = exitCodeOf(part.output);
    return { id, command, output: outputText(part.output), state: "done", ...(exitCode != null ? { exitCode } : {}) };
  }
  // input-streaming / input-available / approval-requested: still on its way.
  return { id, command, output: undefined, state: "running" };
}

/**
 * Every shell command the agent ran in this thread, in chronological order —
 * vgent's `bash`, Claude Code's `Bash`, Codex's `shell` (surfaced as `bash`).
 * Classification is `toolMeta`'s, so there is exactly one place that decides
 * what counts as a shell command.
 */
export function collectTerminalEntries(messages: readonly UIMessage[]): TerminalEntry[] {
  const entries: TerminalEntry[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (describeTool(part).kind !== "bash") continue;
      entries.push(toEntry(part));
    }
  }
  return entries;
}
