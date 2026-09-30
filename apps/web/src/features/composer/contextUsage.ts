import { isToolUIPart, type LanguageModelUsage, type UIMessage } from "ai";
import type { ChangedFile, ModelCost, ThreadMessageMetadata, UsageInfo } from "@/lib/types";
import { completedCompactionRequest, isCompactionMarker, sinceCompaction } from "@/lib/compaction";

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

export type ContextUsage = {
  tokens: number;
  /** `usage` = an engine's own count; `estimate` = the character heuristic below. */
  source: "usage" | "estimate";
} | { tokens: undefined; source: "unknown" };

/**
 * The prompt size the engine itself reported for its last model call.
 *
 * Nothing is added for cached tokens: AI SDK v7's `inputTokens` is the whole
 * prompt, and `inputTokenDetails.cacheReadTokens` is the cached *part* of it,
 * not an extra amount on top.
 */
function reportedInputTokens(message: UIMessage): number | undefined {
  const usage = (message.metadata as ThreadMessageMetadata | undefined)?.usage;
  const inputTokens = usage?.inputTokens;
  // 0 is never a real prompt size — the Codex harness bridge emits `finish-step` without
  // usage, which lands here as all-zero counts, not as `undefined`.
  return typeof inputTokens === "number" && inputTokens > 0 ? inputTokens : undefined;
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
 * mark the number as approximate. A message with `inputTokens: 0` (the Codex
 * harness bridge's `finish-step` without usage) counts as unreported too.
 */
export function contextUsage(messages: readonly UIMessage[]): ContextUsage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    // A native command retains the visible history but replaces the runtime's
    // context. Without fresh usage, neither the old count nor that history is
    // an estimate of what the model now sees.
    if (completedCompactionRequest(message)) return { tokens: undefined, source: "unknown" };
    // The in-house engine's summary: the model now reads it and the turns it
    // kept, not the history the last count was taken on.
    if (isCompactionMarker(message)) return { tokens: Math.round(promptChars(sinceCompaction(messages) ?? []) / CHARS_PER_TOKEN), source: "estimate" };
    if (message == null || message.role !== "assistant") continue;
    const tokens = reportedInputTokens(message);
    if (tokens != null) return { tokens, source: "usage" };
  }
  return { tokens: Math.round(promptChars(messages) / CHARS_PER_TOKEN), source: "estimate" };
}

/**
 * The task's tokens so far, for the card behind the ring: every finished
 * turn's `totalUsage` added up, in the v7 shape AI Elements' `Context` reads.
 * Undefined until some turn reported one. A turn still running is not in it
 * yet, and history `/compact` replaced is gone from it with the messages.
 */
export function taskUsage(messages: readonly UIMessage[]): LanguageModelUsage | undefined {
  let found = false;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const turn: UsageInfo | undefined = (message.metadata as ThreadMessageMetadata | undefined)?.totalUsage;
    if (turn == null || !((turn.inputTokens ?? 0) > 0 || (turn.outputTokens ?? 0) > 0)) continue;
    found = true;
    input += turn.inputTokens ?? 0;
    cacheRead += turn.cachedInputTokens ?? 0;
    cacheWrite += turn.cacheWriteTokens ?? 0;
    output += turn.outputTokens ?? 0;
    reasoning += turn.reasoningTokens ?? 0;
  }
  if (!found) return undefined;
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: Math.max(0, input - cacheRead - cacheWrite), cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens: output,
    outputTokenDetails: { textTokens: Math.max(0, output - reasoning), reasoningTokens: reasoning },
    totalTokens: input + output,
  };
}

export interface UsageCost {
  /** Everything read in: fresh input, cache hits and cache writes, each at its own price. */
  input: number;
  output: number;
  total: number;
}

/**
 * `usage` at `cost` (USD per million tokens). A cache read or write the vendor
 * does not price apart is charged as fresh input; reasoning is inside
 * `outputTokens` already and is not charged twice.
 */
export function usageCost(usage: LanguageModelUsage, cost: ModelCost): UsageCost {
  const details = usage.inputTokenDetails;
  const cacheRead = details.cacheReadTokens ?? 0;
  const cacheWrite = details.cacheWriteTokens ?? 0;
  const fresh = details.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  const input = (fresh * cost.input + cacheRead * (cost.cacheRead ?? cost.input) + cacheWrite * (cost.cacheWrite ?? cost.input)) / 1e6;
  const output = ((usage.outputTokens ?? 0) * cost.output) / 1e6;
  return { input, output, total: input + output };
}

/** `1234` → `1.2k`, `200000` → `200k`; small counts stay exact. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  if (thousands < 1000) return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  const millions = thousands / 1000;
  // A window is a round number: 1M, not 1.0M.
  return `${millions < 100 ? millions.toFixed(1).replace(/\.0$/, "") : Math.round(millions)}M`;
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
