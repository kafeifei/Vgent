import { getToolName } from "ai";
import { exploreKindOf } from "./explore";
import { describeTool, type ToolKind } from "./toolMeta";
import { isOpenApproval, isOpenQuestion, type Block } from "./turns";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type ReasoningBlock = Extract<Block, { kind: "reasoning" }>;

/**
 * One run of tool calls. Thinking is not a row in the run: `thought` is only
 * the reasoning that has not been followed by a tool yet, and it is what the
 * title line shows during a gap. Text, an interjection, a plan, a subagent,
 * and anything waiting on the user end the run so they stay on their own.
 */
export interface ActivityRun {
  kind: "activity";
  key: string;
  tools: ToolBlock[];
  thought: ReasoningBlock[];
}

export type Segment = ActivityRun | { kind: "block"; block: Block };

/**
 * `live` while this run is the tail of a turn that has not started its reply.
 * `summary` once two or more tools sit behind something else.
 * `plain` is a single settled tool, which keeps its own line.
 * `omit` is a thought with no tools, left behind a reply.
 */
export type ActivityMode = "live" | "summary" | "plain" | "omit";

export function activityMode(toolCount: number, liveEdge: boolean): ActivityMode {
  if (toolCount === 0) return liveEdge ? "live" : "omit";
  if (liveEdge) return "live";
  if (toolCount >= 2) return "summary";
  return "plain";
}

const GROUPED: ReadonlySet<ToolKind> = new Set(["read", "search", "bash", "write", "edit", "other"]);

function isGroupedTool(block: Block): block is ToolBlock {
  if (block.kind !== "tool") return false;
  if (isOpenApproval(block.part) || isOpenQuestion(block.part)) return false;
  if (getToolName(block.part) === "askUserQuestions") return false;
  return GROUPED.has(describeTool(block.part).kind);
}

export function segmentsOf(blocks: readonly Block[]): Segment[] {
  const segments: Segment[] = [];
  let run: ActivityRun | null = null;
  const flush = () => {
    if (run != null && (run.tools.length > 0 || run.thought.length > 0)) segments.push(run);
    run = null;
  };
  for (const block of blocks) {
    if (block.kind === "reasoning") {
      run ??= { kind: "activity", key: block.key, tools: [], thought: [] };
      run.thought.push(block);
      continue;
    }
    if (isGroupedTool(block)) {
      // A tool ends the thought that led to it. The next gap starts clean.
      run ??= { kind: "activity", key: block.key, tools: [], thought: [] };
      run.tools.push(block);
      run.thought = [];
      continue;
    }
    flush();
    segments.push({ kind: "block", block });
  }
  flush();
  return segments;
}

export interface ThinkingLabel {
  label: string;
  streaming: boolean;
  body?: string;
}

const TITLE_LIMIT = 40;

/** The title line during a gap: a short heading the thought already has, otherwise 「正在思考」. */
export function thinkingLabel(thought: readonly ReasoningBlock[]): ThinkingLabel {
  const latest = thought.at(-1);
  const text = latest?.part.text.trim() ?? "";
  if (latest == null || text === "") return { label: "正在思考", streaming: true };
  const streaming = latest.part.state === "streaming";
  const bold = /^\*\*([^\n*]{1,80})\*\*(?:\s*|$)/.exec(text);
  if (bold?.[1] != null) {
    const body = text.slice(bold[0].length).trim();
    return { label: bold[1], streaming, ...(body !== "" ? { body } : {}) };
  }
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (first.length > 0 && first.length <= TITLE_LIMIT) {
    if (newline === -1) return { label: first, streaming };
    const body = text.slice(newline + 1).trim();
    return { label: first, streaming, ...(body !== "" ? { body } : {}) };
  }
  return { label: streaming ? "正在思考" : "已完成思考", streaming, body: text };
}

type Category = "tool" | "read" | "search" | "command" | "edit";

const CATEGORY_ORDER: readonly Category[] = ["tool", "read", "search", "command", "edit"];

function categoryOf(kind: ToolKind): Category | undefined {
  switch (kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "bash":
      return "command";
    case "write":
    case "edit":
      return "edit";
    case "other":
      return "tool";
    default:
      return undefined;
  }
}

function phrase(category: Category, count: number, leading: boolean): string {
  if (category === "tool") return count === 1 ? "加载了一个工具" : "加载了工具";
  if (category === "read") return leading ? "已读取文件" : "读取文件";
  if (category === "search") return leading ? "已搜索" : "搜索了";
  if (category === "command") return "运行了命令";
  return leading ? (count === 1 ? "编辑了一个文件" : "编辑了文件") : count === 1 ? "编辑了一个文件" : "编辑了多个文件";
}

/** The collapsed title of a finished run. Categories are concatenated, and the first one uses its leading form. */
export function summaryLabel(tools: readonly ToolBlock[]): string {
  const counts: Record<Category, number> = { tool: 0, read: 0, search: 0, command: 0, edit: 0 };
  for (const tool of tools) {
    // A shell command that only reads or searches counts as that, not as a command.
    const explore = exploreKindOf(tool.part);
    const category = explore != null ? (explore === "search" ? "search" : "read") : categoryOf(describeTool(tool.part).kind);
    if (category != null) counts[category] += 1;
  }
  return CATEGORY_ORDER.filter((category) => counts[category] > 0)
    .map((category, index) => phrase(category, counts[category], index === 0))
    .join("");
}
