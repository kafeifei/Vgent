/**
 * 插话: a message the user sends while a turn is running, taken into that turn
 * at the runtime's next safe boundary instead of waiting for it to end.
 *
 * In the stored history it is a `data-steer` part inside the turn's assistant
 * message, at the point it went in. The UI message stream is one message per
 * turn — there is no way to end an assistant message, show a user one and open
 * another mid-stream — and a data part is exactly how that protocol carries
 * something that is neither text nor a tool call. The log draws it as a user
 * message in the middle of the turn; `expandSteers` turns it back into a real
 * `user` message for anything that reads the history as a conversation.
 */
import { randomUUID } from "node:crypto";
import type { UIMessage, UIMessageChunk } from "ai";

export const STEER_PART_TYPE = "data-steer";

export interface SteerData {
  text: string;
}

export const steerChunk = (text: string): UIMessageChunk => ({ type: STEER_PART_TYPE, id: randomUUID(), data: { text } satisfies SteerData });

/** The text of a `data-steer` part; `undefined` for any other part. */
export function steerTextOf(part: UIMessage["parts"][number]): string | undefined {
  if (part.type !== STEER_PART_TYPE) return undefined;
  const data = (part as { data?: unknown }).data;
  const text = typeof data === "object" && data !== null ? (data as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : undefined;
}

/** Parts that say something. A slice holding only `step-start` markers is not a message. */
const hasContent = (parts: UIMessage["parts"]): boolean => parts.some((part) => part.type !== "step-start");

/**
 * The history as the conversation it was: every assistant message that took a
 * 插话 is cut there into assistant / user / assistant. Messages without one
 * come back as they are, so the common case costs one scan.
 *
 * The cut pieces get derived ids. Nothing stores them — this is only ever the
 * input of a conversion to model messages, a transcript or a summary.
 */
export function expandSteers(messages: readonly UIMessage[]): UIMessage[] {
  const expanded: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !message.parts.some((part) => part.type === STEER_PART_TYPE)) {
      expanded.push(message);
      continue;
    }
    let slice: UIMessage["parts"] = [];
    let cut = 0;
    const flush = (): void => {
      if (hasContent(slice)) expanded.push({ ...message, id: `${message.id}~${cut}`, parts: slice });
      slice = [];
      cut += 1;
    };
    for (const part of message.parts) {
      const text = steerTextOf(part);
      if (text == null) {
        if (part.type !== STEER_PART_TYPE) slice.push(part);
        continue;
      }
      flush();
      expanded.push({ id: `${message.id}~${cut}`, role: "user", parts: [{ type: "text", text }] });
      cut += 1;
    }
    flush();
  }
  return expanded;
}
