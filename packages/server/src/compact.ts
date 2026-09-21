import { randomUUID } from "node:crypto";
import { convertToModelMessages, generateText, type LanguageModel, type UIMessage } from "ai";
import type { ThreadRecord } from "./types.js";
import { expandSteers } from "./steer.js";

/**
 * What the summariser is asked for. The result becomes the *only* thing the
 * next turn knows about everything before it, so it is aimed at continuing the
 * work rather than at reading nicely.
 */
const SUMMARISER_INSTRUCTIONS = `你在压缩一段编码助手和用户的对话，压缩后的摘要会替换掉原始记录，成为后续工作唯一能看到的上下文。

摘要要保留：
- 用户的目标和明确要求（包括说过的约束、偏好、否决过的方案）
- 已经做出的决定和理由
- 改过、读过的关键文件和它们的作用
- 当前进展：什么已完成并验证过，什么还没做
- 未决事项：待确认的问题、已知的坑、下一步

用 markdown 分条写，中文，不要复述寒暄和工具调用细节，不要臆造没发生过的事，控制在 600 字以内。`;

export interface CompactResult {
  /** The two messages that replace the whole history. */
  messages: UIMessage[];
  /** How many messages were compacted away. */
  before: number;
}

/**
 * Replaces a thread's history with a summary of it plus a one-line assistant
 * acknowledgement, so the next turn starts from a short prompt and the engine —
 * which is stateless between turns and re-sends the whole array — needs no
 * changes at all.
 *
 * Separate from the route so it can be unit-tested with a mock model.
 */
export async function compactThread({ thread, model }: { thread: ThreadRecord; model: LanguageModel }): Promise<CompactResult> {
  const before = thread.messages.length;
  // A turn that stopped on an open approval leaves a tool call with no result;
  // dropping those is what makes an arbitrary stored history convertible.
  const modelMessages = await convertToModelMessages(expandSteers(thread.messages), { ignoreIncompleteToolCalls: true });
  const { text } = await generateText({
    model,
    instructions: SUMMARISER_INSTRUCTIONS,
    messages: [...modelMessages, { role: "user", content: "请按要求总结以上对话。" }],
  });

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
    ],
  };
}
