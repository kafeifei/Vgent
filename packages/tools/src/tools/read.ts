import { tool } from "ai";
import { z } from "zod";
import type { FileSystemLike } from "../fs.js";

const MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_LIMIT = 2000;
const BINARY_SNIFF_BYTES = 8192;
const LINE_NUMBER_WIDTH = 6;

function looksBinary(bytes: Uint8Array): boolean {
  const scanLength = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < scanLength; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Formats lines the way `cat -n` does: right-justified line number, a tab, then the line. */
function formatWithLineNumbers(lines: readonly string[], startLine: number): string {
  return lines.map((line, i) => `${String(startLine + i).padStart(LINE_NUMBER_WIDTH)}\t${line}`).join("\n");
}

export interface ReadToolDeps {
  fs: FileSystemLike;
  resolvePath: (filePath: string) => Promise<string>;
}

export function createReadTool({ fs, resolvePath }: ReadToolDeps) {
  return tool({
    description:
      "Read a text file from the working directory. Returns its content with 1-based line numbers " +
      "(like `cat -n`). Reads at most 2000 lines by default; use `offset`/`limit` to page through a " +
      "larger file. Files over 1 MiB and binary files are rejected — use `grep` to search those instead.",
    inputSchema: z.object({
      file_path: z.string().min(1).describe("Path to the file to read. Absolute, or relative to the working directory."),
      offset: z.number().int().min(1).optional().describe("1-based line number to start reading from. Defaults to 1."),
      limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Defaults to 2000."),
    }),
    outputSchema: z.object({
      path: z.string().describe("The resolved absolute path that was read."),
      content: z.string().describe("The file content, prefixed with 1-based line numbers."),
      truncated: z.boolean().describe("True when the file has more lines than were returned."),
      totalLines: z.number().describe("Total number of lines in the file."),
    }),
    execute: async ({ file_path, offset, limit }) => {
      const resolved = await resolvePath(file_path);
      const info = await fs.stat(resolved);
      if (info === null) throw new Error(`File not found: ${file_path}`);
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `"${file_path}" is too large to read (${info.size} bytes, max ${MAX_FILE_BYTES}). Use grep to search it instead of reading it whole.`,
        );
      }

      const bytes = await fs.readBinaryFile(resolved);
      if (bytes === null) throw new Error(`File not found: ${file_path}`);
      if (looksBinary(bytes)) {
        throw new Error(`"${file_path}" looks like a binary file (it contains a NUL byte). Do not read binary files with this tool.`);
      }

      const text = Buffer.from(bytes).toString("utf8");
      const rawLines = text === "" ? [] : text.split("\n");
      // A trailing "\n" terminates the last line rather than starting a new (empty) one.
      const lines = text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
      const totalLines = lines.length;
      const startLine = offset ?? 1;
      const maxLines = limit ?? DEFAULT_LIMIT;
      const startIdx = Math.max(0, startLine - 1);
      const selected = lines.slice(startIdx, startIdx + maxLines);

      return {
        path: resolved,
        content: formatWithLineNumbers(selected, startIdx + 1),
        truncated: startIdx + selected.length < totalLines,
        totalLines,
      };
    },
  });
}
