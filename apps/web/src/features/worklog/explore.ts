import { getToolName } from "ai";
import { describeTool, field, type ToolPart } from "./toolMeta";
import type { Block } from "./turns";

type ToolBlock = Extract<Block, { kind: "tool" }>;

/**
 * The three things an agent does while it is only looking: read a file,
 * search for a pattern, list a directory. Koma folds a run of these into one
 * 「已探索」 line; a command that changes something never joins it.
 */
export type ExploreKind = "read" | "search" | "list";

// Shell words that only read. A pipeline is exploration when every stage is
// one of these (or a filter) and at least one is a primary.
const READ = new Set(["cat", "head", "tail", "nl", "less", "more", "wc", "stat", "file", "od", "hexdump", "strings", "jq", "bat"]);
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);
const LIST = new Set(["ls", "tree", "fd", "du", "pwd"]);
// Read-only git subcommands. `git branch` prints unless it is given a name.
const GIT_READ = new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "describe", "shortlog", "reflog", "remote"]);
// Stages that shape output without touching anything; they never make a pipeline exploration on their own.
const FILTER = new Set(["sort", "uniq", "cut", "tr", "awk", "column", "paste", "basename", "dirname", "realpath", "echo", "printf", "true", "which", "type", "test", "[", "xxd"]);
const SKIP = new Set(["cd", "pushd", "popd", "export", "unset", "set"]);

/** Splits a command line into pipeline stages, each a list of words. `undefined` when it is more than a pipeline. */
function stagesOf(command: string): string[][] | undefined {
  const stages: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  const endWord = () => {
    if (has) words.push(word);
    word = "";
    has = false;
  };
  const endStage = () => {
    endWord();
    if (words.length > 0) stages.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote != null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        word += command[i];
      } else word += ch;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) {
        i += 1;
        if (command[i] !== "\n") {
          word += command[i];
          has = true;
        }
      }
      continue;
    }
    // Subshells, substitutions, heredocs and loops are more than a look.
    if (ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}") return undefined;
    if (ch === "$" && command[i + 1] === "(") return undefined;
    if (ch === "<" && command[i + 1] === "<") return undefined;
    if (ch === ">" || ch === "<") {
      // Only the discarding redirects stay read-only.
      const rest = command.slice(i).match(/^(?:&?>{1,2}\s*\/dev\/null|>&\s*\d|<\s*\/dev\/null)/);
      if (rest == null) return undefined;
      i += rest[0].length - 1;
      endWord();
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n") {
      endStage();
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    word += ch;
    has = true;
  }
  if (quote != null) return undefined;
  endStage();
  return stages;
}

function stageKind(words: readonly string[]): ExploreKind | "filter" | "skip" | undefined {
  let index = 0;
  // `FOO=bar cmd` — the assignment is not the command. A word that is only
  // an assignment sets a variable, which is fine, and there is nothing else.
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index += 1;
  const name = words[index];
  if (name == null) return "skip";
  const args = words.slice(index + 1);
  if (SKIP.has(name)) return "skip";
  if (name === "sudo" || name === "xargs" || name === "sh" || name === "bash" || name === "zsh") return undefined;
  if (name === "sed") return args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place")) ? undefined : "read";
  if (name === "find") return args.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir" || arg === "-ok") ? undefined : "list";
  if (name === "git") {
    const sub = args.find((arg) => !arg.startsWith("-"));
    if (sub == null) return undefined;
    if (sub === "grep") return "search";
    if (GIT_READ.has(sub)) return sub === "remote" && args.some((arg) => !arg.startsWith("-") && arg !== "remote" && arg !== "show") ? undefined : "read";
    if (sub === "branch" || sub === "tag" || sub === "stash") {
      const rest = args.slice(args.indexOf(sub) + 1);
      const readOnly = rest.every((arg) => arg.startsWith("-") ? /^(-a|-r|-v|-vv|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|--show-current)$/.test(arg) : sub === "stash" && arg === "list");
      return readOnly && (sub !== "stash" || rest.includes("list")) ? "list" : undefined;
    }
    return undefined;
  }
  if (name === "awk") return args.some((arg) => arg === "-i" || arg.startsWith("-i")) ? undefined : "filter";
  if (READ.has(name)) return "read";
  if (SEARCH.has(name)) return "search";
  if (LIST.has(name)) return "list";
  if (FILTER.has(name)) return "filter";
  return undefined;
}

/**
 * What a shell command is, when it only looks: `sed -n 10,20p a.ts` reads,
 * `grep -rn foo src | head` searches, `ls -la` lists. Anything that could
 * change something, or that the parser cannot see through, is a command.
 * One kind per command, search before read before list, as the group counts
 * each call once.
 */
export function shellExploreKind(command: string): ExploreKind | undefined {
  const stages = stagesOf(command);
  if (stages == null || stages.length === 0) return undefined;
  const kinds = new Set<ExploreKind>();
  for (const stage of stages) {
    const kind = stageKind(stage);
    if (kind == null) return undefined;
    if (kind === "read" || kind === "search" || kind === "list") kinds.add(kind);
  }
  if (kinds.has("search")) return "search";
  if (kinds.has("read")) return "read";
  if (kinds.has("list")) return "list";
  return undefined;
}

/** The exploration kind of a tool call, across our tools, Claude Code's and Codex's. */
export function exploreKindOf(part: ToolPart): ExploreKind | undefined {
  const display = describeTool(part);
  if (display.kind === "read") return "read";
  if (display.kind === "search") return "search";
  if (display.kind === "bash") return shellExploreKind(field(part.input, "command") ?? "");
  if (display.kind === "other" && getToolName(part).toLowerCase() === "list") return "list";
  return undefined;
}

export type ExploreCounts = Record<ExploreKind, number>;

export function exploreCounts(tools: readonly ToolBlock[]): ExploreCounts {
  const counts: ExploreCounts = { read: 0, search: 0, list: 0 };
  for (const tool of tools) {
    const kind = exploreKindOf(tool.part);
    if (kind != null) counts[kind] += 1;
  }
  return counts;
}

/** `读取 3 个文件 · 搜索 2 次 · 列出 1 个目录` — the one line a fold of looks shows. */
export function exploreLabel(counts: ExploreCounts): string {
  const parts: string[] = [];
  if (counts.read > 0) parts.push(`读取 ${counts.read} 个文件`);
  if (counts.search > 0) parts.push(`搜索 ${counts.search} 次`);
  if (counts.list > 0) parts.push(`列出 ${counts.list} 个目录`);
  return parts.join(" · ");
}
