import { createReadStream } from "node:fs";
import { fingerprint, type ObservedFiles } from "../mutations.js";
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
  observed?: ObservedFiles;
  onRead?: (path: string) => Promise<void>;
  allowLarge?: (path: string) => boolean | Promise<boolean>;
  resolvePath: (filePath: string) => Promise<string>;
}

export function createReadTool({ fs, resolvePath, observed, onRead, allowLarge }: ReadToolDeps) {
  return tool({
    description:
      "Read a text file from the working directory. Returns its content with 1-based line numbers " +
      "(like `cat -n`). Reads at most 2000 lines by default; use `offset`/`limit` to page through a " +
      "larger file. byteLength and endsWithNewline describe the original file; numbered content omits the final newline. " +
      "For byte-exact copies, use a copy operation and compare bytes. Files over 1 MiB are rejected except saved command logs.",
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
      byteLength: z.number().describe("Total UTF-8 bytes in the original file, including its final newline."),
      endsWithNewline: z.boolean().describe("Whether the original file ends in a newline; numbered content does not preserve it."),
    }),
    execute: async ({ file_path, offset, limit }, { abortSignal }) => {
      abortSignal?.throwIfAborted();
      const resolved = await resolvePath(file_path);
      const info = await fs.stat(resolved);
      if (info === null) throw new Error(`File not found: ${file_path}`);
      if (info.size > MAX_FILE_BYTES && (await allowLarge?.(resolved))) {
        const input = createReadStream(resolved, { encoding: "utf8", ...(abortSignal ? { signal: abortSignal } : {}) });
        const selected: string[] = [];
        const start = offset ?? 1;
        const count = Math.min(limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
        let totalLines = 0;
        let length = 0;
        let cut = false;
        let line = "";
        let overflow = false;
        let byteLength = 0;
        let endsWithNewline = false;
        const completeLine = () => {
          totalLines++;
          if (totalLines >= start && totalLines < start + count) {
            const available = Math.max(0, MAX_FILE_BYTES - length);
            const text = line.slice(0, available);
            if (overflow || text.length !== line.length) cut = true;
            if (available > 0) {
              selected.push(`${String(totalLines).padStart(LINE_NUMBER_WIDTH)}\t${text}`);
              length += text.length;
            } else cut = true;
          }
          line = "";
          overflow = false;
        };
        try {
          for await (const chunk of input) {
            abortSignal?.throwIfAborted();
            byteLength += Buffer.byteLength(String(chunk), "utf8");
            endsWithNewline = String(chunk).endsWith("\n");
            const pieces = String(chunk).split("\n");
            for (let i = 0; i < pieces.length; i++) {
              const piece = pieces[i]!;
              if (line.length + piece.length > MAX_FILE_BYTES) overflow = true;
              line += piece.slice(0, Math.max(0, MAX_FILE_BYTES - line.length));
              if (i < pieces.length - 1) completeLine();
            }
          }
          if (line.length || overflow) completeLine();
        } finally {
          input.destroy();
        }
        return {
          path: resolved,
          content: selected.join("\n") + (cut ? "\n[Some lines exceed the page size; use grep to inspect them.]" : ""),
          truncated: cut || totalLines >= start + count,
          totalLines,
          byteLength,
          endsWithNewline,
        };
      }
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
      observed?.set(resolved, fingerprint(text));
      await onRead?.(resolved);
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
        byteLength: bytes.length,
        endsWithNewline: text.endsWith("\n"),
      };
    },
  });
}
