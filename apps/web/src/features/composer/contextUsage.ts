import { isToolUIPart, type UIMessage } from "ai";
import type { ChangedFile, ThreadMessageMetadata } from "@/lib/types";

/**
 * The two numbers the review bar above the composer shows: how full the context
 * window is, and how much this task has changed on disk. Both are pure so the
 * components stay dumb.
 */

/**
 * Denominator when the model catalog reports no window for the current model —
 * the Anthropic models API does not return one, and a thread on 「默认」 names no
 * model to look up. 200k is the smallest window any engine Vgent drives runs
 * with, so the ring errs towards showing *more* pressure, never less.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Rough characters-per-token, only used when no engine reported real counts. */
const CHARS_PER_TOKEN = 4;

export interface ContextUsage {
  tokens: number;
  /** `usage` = an engine's own count; `estimate` = the character heuristic below. */
  source: "usage" | "estimate";
}

/**
 * The prompt size the engine itself reported for its last model call.
 *
 * Nothing is added for cached tokens: AI SDK v7's `inputTokens` is the whole
 * prompt, and `inputTokenDetails.cacheReadTokens` is the cached *part* of it,
 * not an extra amount on top.
 */
function reportedInputTokens(message: UIMessage): number | undefined {
  const usage = (message.metadata as ThreadMessageMetadata | undefined)?.usage;
  return typeof usage?.inputTokens === "number" ? usage.inputTokens : undefined;
}

/** Everything the model would have had to read, as characters. */
function promptChars(messages: readonly UIMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        chars += part.text.length;
        // `isToolUIPart` covers dynamic (MCP) tool parts as well as static ones.
      } else if (isToolUIPart(part)) {
        if (part.input != null) chars += JSON.stringify(part.input).length;
        if (part.state === "output-available" && part.output != null) chars += JSON.stringify(part.output).length;
      }
    }
  }
  return chars;
}

/**
 * How much context the thread occupies.
 *
 * Preferred source is the last assistant message an engine attached usage to
 * (see `ThreadMessageMetadata`) — its `inputTokens` *is* the prompt that call
 * sent. A thread whose engine reports nothing, or one still on its first turn,
 * falls back to counting characters, and says so through `source` so the UI can
 * mark the number as approximate.
 */
export function contextUsage(messages: readonly UIMessage[]): ContextUsage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message == null || message.role !== "assistant") continue;
    const tokens = reportedInputTokens(message);
    if (tokens != null) return { tokens, source: "usage" };
  }
  return { tokens: Math.round(promptChars(messages) / CHARS_PER_TOKEN), source: "estimate" };
}

/** `1234` → `1.2k`, `200000` → `200k`; small counts stay exact. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
}

export interface ChangeSums {
  files: number;
  additions: number;
  deletions: number;
}

/** The 审查 pill's `+N −M`, summed over the snapshot's files. */
export function sumChanges(files: readonly ChangedFile[]): ChangeSums {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { files: files.length, additions, deletions };
}
