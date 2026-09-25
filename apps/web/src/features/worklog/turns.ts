import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ThreadMessageMetadata } from "@/lib/types";
import type { ToolPart } from "./toolMeta";

export type TextPart = Extract<UIMessage["parts"][number], { type: "text" }>;
export type ReasoningPart = Extract<UIMessage["parts"][number], { type: "reasoning" }>;

export type Block =
  | { kind: "reasoning"; key: string; part: ReasoningPart }
  | { kind: "text"; key: string; part: TextPart }
  | { kind: "tool"; key: string; part: ToolPart }
  /** 插话: what the user said while this turn was running, at the point it went in. */
  | { kind: "steer"; key: string; text: string }
  /** 压缩: the runtime compacted its context here (see `compaction.ts` on the server). */
  | { kind: "compaction"; key: string; data: CompactionData };

export interface CompactionData {
  trigger: "manual" | "auto";
  tokensBefore?: number;
  tokensAfter?: number;
}

function compactionOf(part: UIMessage["parts"][number]): CompactionData | undefined {
  if (part.type !== "data-compaction") return undefined;
  const data = (part as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const { trigger, tokensBefore, tokensAfter } = data as { trigger?: unknown; tokensBefore?: unknown; tokensAfter?: unknown };
  return {
    trigger: trigger === "manual" ? "manual" : "auto",
    ...(typeof tokensBefore === "number" ? { tokensBefore } : {}),
    ...(typeof tokensAfter === "number" ? { tokensAfter } : {}),
  };
}

/** The server's `data-steer` part (see `steer.ts` there): a user message taken into a running turn. */
function steerTextOf(part: UIMessage["parts"][number]): string | undefined {
  if (part.type !== "data-steer") return undefined;
  const data = (part as { data?: unknown }).data;
  const text = typeof data === "object" && data !== null ? (data as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : undefined;
}

/** One user message and everything the assistant did in answer to it. */
export interface Turn {
  key: string;
  user?: UIMessage;
  blocks: Block[];
  /** An assistant message exists for this turn — with no blocks, the model answered with nothing. */
  answered: boolean;
}

/** Set on the summary message `/compact` leaves behind; absent on an ordinary user message. */
export const compactedOf = (message: UIMessage): ThreadMessageMetadata["compacted"] =>
  (message.metadata as ThreadMessageMetadata | undefined)?.compacted;

/** How this user message's turn ended, when it failed or was cut short; absent for a normal finish. */
export const turnEndOf = (message: UIMessage): ThreadMessageMetadata["turnEnd"] =>
  (message.metadata as ThreadMessageMetadata | undefined)?.turnEnd;

/** The anchor ids the right-pane queue scrolls to. */
export const approvalAnchor = (toolCallId: string): string => `approval-${toolCallId}`;
export const questionAnchor = (toolCallId: string): string => `question-${toolCallId}`;

/** True for the `askUserQuestions` call the human still has to answer. */
export const isOpenQuestion = (part: ToolPart): boolean =>
  getToolName(part) === "askUserQuestions" && part.state === "input-available";

export const isOpenApproval = (part: ToolPart): boolean => part.state === "approval-requested";

function blocksOf(message: UIMessage): Block[] {
  const blocks: Block[] = [];
  message.parts.forEach((part, index) => {
    const key = `${message.id}:${index}`;
    const steer = steerTextOf(part);
    const compaction = compactionOf(part);
    if (steer != null) blocks.push({ kind: "steer", key, text: steer });
    else if (compaction != null) blocks.push({ kind: "compaction", key, data: compaction });
    // Blank text is not a reply: some models open a step with a lone space, and
    // one that ends there has said nothing (the turn's `answered` covers that).
    else if (part.type === "text") {
      if (part.text.trim() !== "") blocks.push({ kind: "text", key, part });
    }
    // A reasoning part with no text is what an engine sends when the model
    // reasoned but did not summarize it — the ChatGPT/Codex backend encrypts
    // its reasoning, so every turn carries one unless a summary was asked for.
    // An empty「思考」box says nothing, so it is dropped; the part reappears on
    // its own as soon as deltas start landing in it.
    else if (part.type === "reasoning") {
      if (part.text.trim() !== "") blocks.push({ kind: "reasoning", key, part });
    }
    else if (isToolUIPart(part)) {
      // A call the engine re-issues after an approval pause arrives as a second
      // part with the same id — the SDK only reconciles `tool-input-start`
      // inside the current step — and the stale one is stuck `input-streaming`
      // forever. Only the last part of a `toolCallId` is the real one.
      const stale = blocks.findIndex((block) => block.kind === "tool" && block.part.toolCallId === part.toolCallId);
      if (stale >= 0) blocks.splice(stale, 1);
      blocks.push({ kind: "tool", key, part });
    }
  });
  return blocks;
}

/**
 * Splits the flat message list into turns. Every user message opens one; the
 * assistant messages that follow it belong to that turn. A history that starts
 * with an assistant message (a resumed thread) gets a leading turn with no user
 * box.
 */
export function buildTurns(messages: readonly UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ key: message.id, user: message, blocks: [], answered: false });
      continue;
    }
    if (message.role !== "assistant") continue;
    let turn = turns.at(-1);
    if (turn == null) {
      turn = { key: `head-${message.id}`, blocks: [], answered: false };
      turns.push(turn);
    }
    turn.answered = true;
    turn.blocks.push(...blocksOf(message));
  }
  return turns;
}
