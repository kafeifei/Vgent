import { fitContext, SUMMARY_INSTRUCTIONS } from "@vgent/engine";
import { randomUUID } from "node:crypto";
import { convertToModelMessages, generateText, type LanguageModel, type UIMessage } from "ai";
import type { ThreadMessageMetadata, ThreadRecord } from "./types.js";
import { expandSteers } from "./steer.js";

/**
 * 压缩 for the in-house engine. The history is never rewritten: the summary is
 * a marker message appended at the end, and what the model reads from then on
 * starts at the latest marker (`sinceCompaction`). The log keeps showing every
 * message, with the marker as a line whose summary opens in the right pane.
 */

/** How the summary reads to the model; the log shows the marker, not this. */
export const COMPACTION_PREFIX = "上下文已压缩，以下是之前对话的摘要：\n\n";

/** Said after the summary when the next message would be the user's again. */
const ACKNOWLEDGEMENT = "已了解摘要，继续。";

const compactedOf = (message: UIMessage): ThreadMessageMetadata["compacted"] =>
  message.role === "user" ? (message.metadata as ThreadMessageMetadata | undefined)?.compacted : undefined;

/**
 * The history as the model reads it: from the latest marker on — its summary,
 * the turns it kept word for word (`keptFrom` up to the marker), then whatever
 * came after — or all of it when nothing was ever compacted. An older build's
 * summary replaced what came before and is followed by its acknowledgement,
 * which reads the same way.
 */
export function sinceCompaction(messages: readonly UIMessage[]): UIMessage[] {
  const at = messages.findLastIndex((message) => compactedOf(message) != null);
  if (at < 0) return [...messages];
  const marker = messages[at]!;
  const keptFrom = compactedOf(marker)?.keptFrom;
  const from = keptFrom == null ? -1 : messages.findIndex((message) => message.id === keptFrom);
  // An earlier marker among them is already inside this summary.
  const kept = from >= 0 && from < at ? messages.slice(from, at).filter((message) => compactedOf(message) == null) : [];
  const rest = [...kept, ...messages.slice(at + 1)];
  const reply: UIMessage[] =
    rest[0] == null || rest[0].role === "user" ? [{ id: `${marker.id}-ack`, role: "assistant", parts: [{ type: "text", text: ACKNOWLEDGEMENT }] }] : [];
  return [marker, ...reply, ...rest];
}

/**
 * The marker for a summary of everything the model reads now but the latest
 * turns, which it keeps word for word. Separate from the route so it can be
 * unit-tested with a mock model.
 */
export async function compactThread({ thread, model, window }: { thread: ThreadRecord; model: LanguageModel; window?: number }): Promise<UIMessage> {
  const history = sinceCompaction(thread.messages);
  // A turn that stopped on an open approval leaves a tool call with no result;
  // dropping those is what makes an arbitrary stored history convertible.
  let boundary = Math.max(0, history.length - 4);
  while (boundary > 0 && history[boundary]?.role !== "user") boundary -= 1;
  const recent = boundary > 0 ? history.slice(boundary) : [];
  const prefix = boundary > 0 ? history.slice(0, boundary) : history;
  const converted = await convertToModelMessages(expandSteers(prefix), { ignoreIncompleteToolCalls: true });
  const fitted = await fitContext({
    messages: converted,
    model,
    budget: Math.floor((thread.contextWindow ?? window ?? 180000) * 0.8),
    overhead: 2048,
  });
  const { text } = await generateText({
    model,
    instructions: SUMMARY_INSTRUCTIONS,
    maxOutputTokens: 2048,
    messages: [...fitted.messages, { role: "user", content: "请按要求总结以上对话。" }],
  });
  if (!text.trim()) throw new Error("摘要为空，原记录未修改。");
  const compacted: NonNullable<ThreadMessageMetadata["compacted"]> = {
    before: prefix.length,
    at: new Date().toISOString(),
    ...(recent[0] != null ? { keptFrom: recent[0].id } : {}),
  };
  return {
    id: randomUUID(),
    role: "user",
    parts: [{ type: "text", text: `${COMPACTION_PREFIX}${text.trim()}` }],
    metadata: { compacted } satisfies ThreadMessageMetadata,
  };
}
