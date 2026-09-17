import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ToolPart } from "./toolMeta";

export type TextPart = Extract<UIMessage["parts"][number], { type: "text" }>;
export type ReasoningPart = Extract<UIMessage["parts"][number], { type: "reasoning" }>;

export type Block =
  | { kind: "reasoning"; key: string; part: ReasoningPart }
  | { kind: "text"; key: string; part: TextPart }
  | { kind: "tool"; key: string; part: ToolPart };

/** One user message and everything the assistant did in answer to it. */
export interface Turn {
  key: string;
  user?: UIMessage;
  blocks: Block[];
}

/** The anchor ids the right-pane queue scrolls to. */
export const approvalAnchor = (toolCallId: string): string => `approval-${toolCallId}`;
export const questionAnchor = (toolCallId: string): string => `question-${toolCallId}`;

/** True for the `askUserQuestions` call the human still has to answer. */
export const isOpenQuestion = (part: ToolPart): boolean =>
  getToolName(part) === "askUserQuestions" && part.state === "input-available";

export const isOpenApproval = (part: ToolPart): boolean => part.state === "approval-requested";

/** A block the fold must never hide: it is waiting on the human. */
export const needsHuman = (block: Block): boolean =>
  block.kind === "tool" && (isOpenApproval(block.part) || isOpenQuestion(block.part));

function blocksOf(message: UIMessage): Block[] {
  const blocks: Block[] = [];
  message.parts.forEach((part, index) => {
    const key = `${message.id}:${index}`;
    if (part.type === "text") blocks.push({ kind: "text", key, part });
    else if (part.type === "reasoning") blocks.push({ kind: "reasoning", key, part });
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
      turns.push({ key: message.id, user: message, blocks: [] });
      continue;
    }
    if (message.role !== "assistant") continue;
    let turn = turns.at(-1);
    if (turn == null) {
      turn = { key: `head-${message.id}`, blocks: [] };
      turns.push(turn);
    }
    turn.blocks.push(...blocksOf(message));
  }
  return turns;
}

/** A run of blocks that the turn fold collapses together. */
export type Run = { kind: "foldable"; key: string; blocks: Block[] } | { kind: "open"; key: string; blocks: Block[] };

/**
 * Groups a turn's blocks into runs so folding never reorders them: contiguous
 * non-text blocks fold together, text stays visible, and anything waiting on
 * the human stays out of the fold.
 */
export function runsOf(blocks: readonly Block[]): Run[] {
  const runs: Run[] = [];
  for (const block of blocks) {
    const foldable = block.kind !== "text" && !needsHuman(block);
    const kind = foldable ? "foldable" : "open";
    const last = runs.at(-1);
    if (last?.kind === kind) last.blocks.push(block);
    else runs.push({ kind, key: block.key, blocks: [block] });
  }
  return runs;
}
