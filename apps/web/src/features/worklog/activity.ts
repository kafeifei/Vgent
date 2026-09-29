import { getToolName } from "ai";
import { exploreKindOf } from "./explore";
import { describeTool, hasToolFailure } from "./toolMeta";
import { isOpenApproval, isOpenQuestion, type Block } from "./turns";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type ReasoningBlock = Extract<Block, { kind: "reasoning" }>;
export type RowBlock = Exclude<Block, { kind: "reasoning" }>;

/**
 * One line of a turn's process, in the order it happened. A `thought` is the
 * reasoning of one stretch of tool calls, hoisted above them as one row, so
 * thinking never sits between every two calls. An `explore` is two or more
 * consecutive looks (reads, searches, listings) on one line with counts.
 * Unclassified shell calls still group as `commands`; their category need not
 * be guessed to fold them. Edits, cards and replies remain separate rows.
 */
export type ProcessItem =
  | { kind: "thought"; key: string; parts: ReasoningBlock[] }
  | { kind: "explore" | "commands"; key: string; tools: ToolBlock[] }
  | { kind: "block"; key: string; block: RowBlock };

type ProcessSection =
  | { kind: "text"; key: string; block: Extract<Block, { kind: "text" }> }
  | { kind: "steer"; key: string; block: Extract<Block, { kind: "steer" }> }
  | { kind: "attention"; key: string; block: ToolBlock }
  | { kind: "activity"; key: string; blocks: Block[] };

/** Assistant text, user interjections and work needing attention stay outside completed folds. */
export function processSectionsOf(blocks: readonly Block[]): ProcessSection[] {
  const sections: ProcessSection[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      sections.push({ kind: "text", key: block.key, block });
    } else if (block.kind === "steer") {
      sections.push({ kind: "steer", key: block.key, block });
    } else if (block.kind === "tool" && (hasToolFailure(block.part) || isOpenApproval(block.part) || isOpenQuestion(block.part))) {
      sections.push({ kind: "attention", key: block.key, block });
    } else {
      const previous = sections.at(-1);
      if (previous?.kind === "activity") previous.blocks.push(block);
      else sections.push({ kind: "activity", key: block.key, blocks: [block] });
    }
  }
  return sections;
}

/** A call that is waiting on the human, or that is drawn as a card: never a plain row. */
function isCard(block: Block): boolean {
  if (block.kind !== "tool") return false;
  return isOpenApproval(block.part) || isOpenQuestion(block.part) || getToolName(block.part) === "askUserQuestions";
}

export function processItemsOf(blocks: readonly Block[]): ProcessItem[] {
  const items: ProcessItem[] = [];
  let thought: ReasoningBlock[] = [];
  let tools: ToolBlock[] = [];
  const flush = () => {
    if (thought.length > 0) items.push({ kind: "thought", key: thought[0]!.key, parts: thought });
    let pending: ToolBlock[] = [];
    let category: "explore" | "commands" | undefined;
    const flushGroup = () => {
      if (pending.length >= 2 && category != null) items.push({ kind: category, key: pending[0]!.key, tools: pending });
      else for (const block of pending) items.push({ kind: "block", key: block.key, block });
      pending = [];
    };
    for (const block of tools) {
      const next = hasToolFailure(block.part) ? undefined
        : exploreKindOf(block.part) != null ? "explore"
        : describeTool(block.part).kind === "bash" ? "commands" : undefined;
      if (next !== category) flushGroup();
      category = next;
      if (next != null) pending.push(block);
      else {
        items.push({ kind: "block", key: block.key, block });
      }
    }
    flushGroup();
    thought = [];
    tools = [];
  };
  for (const block of blocks) {
    if (block.kind === "reasoning") {
      thought.push(block);
      continue;
    }
    if (block.kind === "tool" && !isCard(block) && !hasToolFailure(block.part)) {
      tools.push(block);
      continue;
    }
    // A reply, an interjection, a compaction mark or a card ends the stretch.
    flush();
    items.push({ kind: "block", key: block.key, block: block as RowBlock });
  }
  flush();
  return items;
}

/**
 * A finished turn: the trailing text is the reply. The process before it folds
 * behind 「工作了 N 步」 in sections, keeping assistant text, user interjections
 * and work needing attention outside.
 */
export function splitReply(blocks: readonly Block[]): { process: Block[]; reply: Block[] } {
  let end = blocks.length;
  while (end > 0 && blocks[end - 1]!.kind === "text") end -= 1;
  return { process: blocks.slice(0, end), reply: blocks.slice(end) };
}

/** How many calls the fold stands for. Cards count too: they were steps. */
export const stepCount = (blocks: readonly Block[]): number => blocks.filter((block) => block.kind === "tool").length;

/** The reasoning of one thought row, as one document. */
export const thoughtText = (parts: readonly ReasoningBlock[]): string =>
  parts
    .map((block) => block.part.text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
