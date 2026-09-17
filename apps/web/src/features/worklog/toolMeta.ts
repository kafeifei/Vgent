import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { oneLine } from "@/lib/format";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolKind = "read" | "search" | "bash" | "write" | "edit" | "agent" | "other";

export interface ToolDisplay {
  kind: ToolKind;
  /** The leading word. `$` for shell commands, which is rendered mono. */
  verb: string;
  /** What the verb acts on: a path, a pattern, a command. Always mono. */
  target: string;
  /** For write/edit: the file the chip points at. */
  file?: string;
}

const field = (input: unknown, ...names: string[]): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
};

/**
 * Tool call → one muted log line. Names cover both our own tools
 * (`read`/`bash`/…) and the Claude Code harness ones (`Read`/`Bash`/…).
 */
export function describeTool(part: ToolPart): ToolDisplay {
  const name = getToolName(part);
  const input = part.input;
  switch (name.toLowerCase()) {
    case "read":
      return { kind: "read", verb: "读取", target: field(input, "file_path", "path") ?? "" };
    case "grep":
    case "glob":
    case "search":
      return {
        kind: "search",
        verb: "搜索",
        target: field(input, "pattern", "query", "glob", "path") ?? "",
      };
    case "bash":
    case "shell":
      return { kind: "bash", verb: "$", target: oneLine(field(input, "command") ?? "", 120) };
    case "write": {
      const file = field(input, "file_path", "path");
      return { kind: "write", verb: "写入", target: file ?? "", ...(file != null ? { file } : {}) };
    }
    case "edit":
    case "multiedit": {
      const file = field(input, "file_path", "path");
      return { kind: "edit", verb: "编辑", target: file ?? "", ...(file != null ? { file } : {}) };
    }
    case "agent":
    case "task":
      return {
        kind: "agent",
        verb: "子代理",
        target: field(input, "description", "subagent_type", "prompt") ?? "",
      };
    default:
      return { kind: "other", verb: name, target: oneLine(field(input, "file_path", "path", "pattern", "command", "description") ?? "", 100) };
  }
}

/** `exit N` for a bash-shaped output, when the engine reports one. */
export function exitCodeOf(output: unknown): number | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const value = (output as Record<string, unknown>).exitCode ?? (output as Record<string, unknown>).exit_code;
  return typeof value === "number" ? value : undefined;
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

/** True while the call is still waiting on the engine rather than on the human. */
export const isToolStreaming = (part: ToolPart): boolean =>
  part.state === "input-streaming" || part.state === "input-available";
