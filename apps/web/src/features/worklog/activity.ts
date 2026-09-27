import { getToolName } from "ai";
import { exploreKindOf } from "./explore";
import { isOpenApproval, isOpenQuestion, type Block } from "./turns";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type ReasoningBlock = Extract<Block, { kind: "reasoning" }>;
export type RowBlock = Exclude<Block, { kind: "reasoning" }>;

/**
 * One line of a turn's process, in the order it happened. A `thought` is the
 * reasoning of one stretch of tool calls, hoisted above them as one row, so
 * thinking never sits between every two calls. An `explore` is two or more
 * consecutive looks (reads, searches, listings) on one line with counts.
 * Everything else — a command, an edit, a card, a reply written mid-way — is
 * its own row.
 */
export type ProcessItem =
  | { kind: "thought"; key: string; parts: ReasoningBlock[] }
  | { kind: "explore"; key: string; tools: ToolBlock[] }
  | { kind: "block"; key: string; block: RowBlock };

type ProcessSection =
  | { kind: "steer"; key: string; block: Extract<Block, { kind: "steer" }> }
  | { kind: "activity"; key: string; blocks: Block[] };

/** User interjections stay visible between the stretches of work they separate. */
export function processSectionsOf(blocks: readonly Block[]): ProcessSection[] {
  const sections: ProcessSection[] = [];
  for (const block of blocks) {
    if (block.kind === "steer") {
      sections.push({ kind: "steer", key: block.key, block });
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
    const flushExplore = () => {
      if (pending.length >= 2) items.push({ kind: "explore", key: pending[0]!.key, tools: pending });
      else for (const block of pending) items.push({ kind: "block", key: block.key, block });
      pending = [];
    };
    for (const block of tools) {
      if (exploreKindOf(block.part) != null) pending.push(block);
      else {
        flushExplore();
        items.push({ kind: "block", key: block.key, block });
      }
    }
    flushExplore();
    thought = [];
    tools = [];
  };
  for (const block of blocks) {
    if (block.kind === "reasoning") {
      thought.push(block);
      continue;
    }
    if (block.kind === "tool" && !isCard(block)) {
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
 * behind 「工作了 N 步」 in sections, with user interjections kept outside.
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
