import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelMessage } from "ai";

/**
 * One line of a session file. JSONL, append-only: a turn's messages are added
 * as they are produced and nothing already written is ever rewritten, so a
 * crash can only ever truncate the tail.
 */
export interface SessionRecord {
  /** Epoch milliseconds the line was appended. */
  ts: number;
  message: ModelMessage;
}

/**
 * Appends messages to a session file, creating it (and its directory) on first
 * write. Plain `appendFile`, no temp+rename: the atomicity that buys is for
 * whole-file rewrites, and this format never rewrites.
 */
export async function appendSession(file: string, messages: readonly ModelMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  const ts = Date.now();
  const lines = messages.map((message) => `${JSON.stringify({ ts, message } satisfies SessionRecord)}\n`).join("");
  await appendFile(file, lines, "utf8");
}

export interface LoadSessionOptions {
  /** Where malformed-line warnings go. Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
}

/**
 * Reads a session file back into messages.
 *
 * A missing file is an empty session, not an error. A trailing partial line —
 * the shape a crash mid-append leaves behind — is skipped with a warning rather
 * than failing the load; a malformed line anywhere else is skipped too, since
 * losing one message beats losing the session.
 */
export async function loadSession(file: string, options: LoadSessionOptions = {}): Promise<ModelMessage[]> {
  const warn = options.onWarn ?? ((message: string) => console.warn(message));

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const messages: ModelMessage[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as SessionRecord;
      if (record?.message == null) throw new Error("record has no message");
      messages.push(record.message);
    } catch {
      // The last line having no terminating newline is the expected truncation
      // case; anything earlier means the file was corrupted some other way.
      const truncated = index === lines.length - 1;
      warn(
        truncated
          ? `Session file ${file} ends with a truncated line; skipping it.`
          : `Session file ${file} has an unparseable line ${index + 1}; skipping it.`,
      );
    }
  }
  return messages;
}
