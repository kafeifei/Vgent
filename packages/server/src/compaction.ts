/**
 * 压缩: a harness runtime compacting its own context mid-conversation — on its
 * own when the window fills, or asked to by `/compact`. The harness reports it
 * as a `compaction` stream part, which the AI SDK's UI stream does not know
 * (`toUIMessageStream` throws on an unknown part), so the run manager takes it
 * out of the engine stream and publishes it as a data part of the turn's
 * assistant message — the same route 插话 takes (`steer.ts`). The log draws a
 * marker from it.
 */
import { randomUUID } from "node:crypto";
import type { UIMessageChunk } from "ai";

export const COMPACTION_PART_TYPE = "data-compaction";

export interface CompactionData {
  trigger: "manual" | "auto";
  tokensBefore?: number;
  tokensAfter?: number;
}

/** The harness's `compaction` stream part, by the fields the marker uses. */
export interface CompactionStreamPart {
  type: "compaction";
  trigger?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
}

export const isCompactionPart = (part: { type: string }): part is CompactionStreamPart => part.type === "compaction";

export function compactionChunk(part: CompactionStreamPart): UIMessageChunk {
  const data: CompactionData = {
    trigger: part.trigger === "manual" ? "manual" : "auto",
    ...(typeof part.tokensBefore === "number" ? { tokensBefore: part.tokensBefore } : {}),
    ...(typeof part.tokensAfter === "number" ? { tokensAfter: part.tokensAfter } : {}),
  };
  return { type: COMPACTION_PART_TYPE, id: randomUUID(), data };
}
