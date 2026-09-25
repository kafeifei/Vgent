import { fitContext, SUMMARY_INSTRUCTIONS } from "@vgent/engine";
import { randomUUID } from "node:crypto";
import { convertToModelMessages, generateText, type LanguageModel, type UIMessage } from "ai";
import type { ThreadRecord } from "./types.js";
import { expandSteers } from "./steer.js";

/**
 * Preserve enough of the older prefix to continue work. The recent original
 * turns remain beside this summary; the route keeps a pre-compaction snapshot.
 */
const SUMMARISER_INSTRUCTIONS = SUMMARY_INSTRUCTIONS;

export interface CompactResult {
  /** The summary, its acknowledgement and the retained recent turns. */
  messages: UIMessage[];
  /** How many messages were compacted away. */
  before: number;
}

/**
 * Replaces the older history with a summary and keeps recent original turns,
 * so the next turn starts from a short prompt and the engine —
 * which is stateless between turns and re-sends the whole array — needs no
 * changes at all.
 *
 * Separate from the route so it can be unit-tested with a mock model.
 */
export async function compactThread({ thread, model }: { thread: ThreadRecord; model: LanguageModel }): Promise<CompactResult> {
  const before = thread.messages.length;
  // A turn that stopped on an open approval leaves a tool call with no result;
  // dropping those is what makes an arbitrary stored history convertible.
  let boundary = Math.max(0, thread.messages.length - 4);
  while (boundary > 0 && thread.messages[boundary]?.role !== "user") boundary -= 1;
  const recent = boundary > 0 ? thread.messages.slice(boundary) : [];
  const prefix = boundary > 0 ? thread.messages.slice(0, boundary) : thread.messages;
  const converted = await convertToModelMessages(expandSteers(prefix), { ignoreIncompleteToolCalls: true });
  const fitted = await fitContext({
    messages: converted,
    model,
    budget: Math.floor((thread.contextWindow ?? 180000) * 0.8),
    overhead: 2048,
  });
  const modelMessages = fitted.messages;
  const { text } = await generateText({
    model,
    instructions: SUMMARISER_INSTRUCTIONS,
    maxOutputTokens: 2048,
    messages: [...modelMessages, { role: "user", content: "请按要求总结以上对话。" }],
  });

  if (!text.trim()) throw new Error("摘要为空，原记录未修改。");
  const at = new Date().toISOString();
  return {
    before,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text: `上下文已压缩，以下是之前对话的摘要：\n\n${text.trim()}` }],
        metadata: { compacted: { before, at } },
      },
      { id: randomUUID(), role: "assistant", parts: [{ type: "text", text: "已了解摘要，继续。" }] },
      ...recent,
    ],
  };
}
