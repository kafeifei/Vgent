import { getToolName, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { oneLine } from "@/lib/format";

export type ToolPart = (ToolUIPart | DynamicToolUIPart) & {
  /** Display-only: the owning turn ended before this call produced a final result. */
  interrupted?: true;
};

export type ToolKind = "read" | "search" | "bash" | "write" | "edit" | "agent" | "plan" | "other";

export interface ToolDisplay {
  kind: ToolKind;
  /** The leading word. `$` for shell commands, which is rendered mono. */
  verb: string;
  /** What the verb acts on: a path, a pattern, a command. Always mono. */
  target: string;
  /** For write/edit: the file the chip points at. */
  file?: string;
}

export const field = (input: unknown, ...names: string[]): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

/**
 * The first file an `apply_patch` call touches (`*** Add File: b.txt`). OpenCode
 * gives GPT models that tool in place of edit and write, and it arrives as an edit.
 */
const patchedFile = (input: unknown): string | undefined => {
  const patch = field(input, "patchText", "patch");
  return patch == null ? undefined : /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(patch)?.[1]?.trim();
};

/** Item count from whichever array shape a plan tool's input carries. */
const planCount = (input: unknown): number | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const list = record.items ?? record.todos ?? record.plan;
  return Array.isArray(list) ? list.length : undefined;
};

/**
 * Drops the `cd <dir>;` / `cd <dir> &&` an agent puts in front of nearly every
 * command so the line starts with what it does, the way Codex's summary does.
 * The full command is still in the row's input.
 */
export function withoutCd(command: string): string {
  return command.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:;|&&)\s*/, "");
}

/**
 * Tool call → one muted log line. Names cover both our own tools
 * (`read`/`bash`/…) and the Claude Code harness ones (`Read`/`Bash`/…);
 * OpenCode's spell the path `filePath`.
 */
export function describeTool(part: ToolPart): ToolDisplay {
  const name = getToolName(part);
  const input = part.input;
  switch (name.toLowerCase()) {
    case "read":
      return { kind: "read", verb: "读取", target: field(input, "file_path", "filePath", "path") ?? "" };
    case "grep":
    case "glob":
    case "search":
      return {
        kind: "search",
        verb: "搜索",
        target: field(input, "pattern", "query", "glob", "path") ?? "",
      };
    case "bash":
    case "shell": {
      const summary = part.title?.trim() || field(input, "description")?.trim();
      return { kind: "bash", verb: summary ? "执行" : "$", target: oneLine(summary || withoutCd(field(input, "command") ?? ""), 120) };
    }
    case "write": {
      const file = field(input, "file_path", "filePath", "path");
      return { kind: "write", verb: "写入", target: file ?? "", ...(file != null ? { file } : {}) };
    }
    case "edit":
    case "multiedit": {
      const file = field(input, "file_path", "filePath", "path") ?? patchedFile(input);
      return { kind: "edit", verb: "编辑", target: file ?? "", ...(file != null ? { file } : {}) };
    }
    case "explore":
      return { kind: "agent", verb: "子代理·探索", target: oneLine(field(input, "prompt") ?? "", 100) };
    case "coder":
      return { kind: "agent", verb: "子代理·编码", target: oneLine(field(input, "task") ?? "", 100) };
    case "agent":
    case "task":
      return {
        kind: "agent",
        verb: "子代理",
        target: field(input, "description", "subagent_type", "prompt") ?? "",
      };
    // Vgent's own plan tool, Claude Code's `TodoWrite`, Codex's `update_plan`.
    case "updateplan":
    case "todowrite":
    case "update_plan": {
      const count = planCount(input);
      return { kind: "plan", verb: "计划", target: count != null ? `${count} 项` : "" };
    }
    default:
      return { kind: "other", verb: name, target: oneLine(field(input, "file_path", "filePath", "path", "pattern", "command", "url", "description") ?? "", 100) };
  }
}

/**
 * Tool name → its Chinese name, for UI that names the *tool* rather than one
 * call (the per-thread allowlist). Deliberately not derived from
 * `describeTool`, whose verbs describe a call and read wrong on their own.
 */
const TOOL_NAMES: Record<string, string> = {
  read: "读取",
  grep: "搜索",
  glob: "搜索",
  bash: "命令",
  shell: "命令",
  write: "写入",
  edit: "编辑",
  multiedit: "编辑",
  explore: "探索子代理",
  coder: "编码子代理",
};

/** How to name a tool in a sentence. Falls back to the raw name. */
export const toolTitle = (name: string): string => TOOL_NAMES[name.toLowerCase()] ?? name;

/** `exit N` for a bash-shaped output, when the engine reports one. */
export function exitCodeOf(output: unknown): number | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>).exitCode ?? (output as Record<string, unknown>).exit_code;
  return typeof value === "number" ? value : undefined;
}

/** Failed, denied or interrupted work stays visible instead of disappearing into a group. */
export function hasToolFailure(part: ToolPart): boolean {
  if (part.interrupted || part.state === "output-error" || part.state === "output-denied") return true;
  const code = part.state === "output-available" ? exitCodeOf(part.output) : undefined;
  return code != null && code !== 0;
}

/** `+N −M` for a write/edit output that carries a unified diff. */
export function diffStatOf(output: unknown): { added: number; removed: number } | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const diff = (output as Record<string, unknown>).diff;
  if (typeof diff !== "string" || diff.length === 0) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

/** The text a tool output should show verbatim (stdout, file content), if any. */
export function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return undefined;
  const record = output as Record<string, unknown>;
  for (const key of ["stdout", "output", "content", "text", "diff"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * A subagent tool's output is the child's own `UIMessage`, streamed part by
 * part. Anything else — a plain object, a string — is not one.
 */
export function asChildMessage(output: unknown): Pick<UIMessage, "parts" | "metadata"> | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const parts = (output as { parts?: unknown }).parts;
  return Array.isArray(parts) ? (output as Pick<UIMessage, "parts" | "metadata">) : undefined;
}

/** A child transcript part that is a tool call, as opposed to text or reasoning. */
export const asChildToolPart = (part: UIMessage["parts"][number]): ToolPart | undefined =>
  part.type === "dynamic-tool" || part.type.startsWith("tool-") ? (part as ToolPart) : undefined;

/** True while the call is still waiting on the engine rather than on the human. */
export const isToolStreaming = (part: ToolPart): boolean =>
  !part.interrupted && (part.state === "input-streaming" || part.state === "input-available"
    || (part.state === "output-available" && part.preliminary === true));
