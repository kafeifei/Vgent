import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileUIPart, UIMessage } from "ai";
import type { EngineId } from "./types.js";

/**
 * 附件 — files the user picked, pasted or dropped onto the composer. They ride
 * in the stored user message as ordinary `file` parts (a `data:` URL), which is
 * what lets the log draw them; what each *engine* gets out of them differs:
 *
 *   · Claude Code and Codex take text only — both harness adapters throw on any
 *     other user part — so the file is written under the data dir and the part
 *     becomes a line naming that path. The CLIs read it with their own tools
 *     (both can look at images).
 *   · The in-house engine talks to the model directly, so an image or a PDF
 *     stays a file part the model sees. Its own tools cannot leave the working
 *     directory, so a path would be no use to it; a text file is inlined instead.
 */

/** A text attachment larger than this is cut, with a note, rather than flooding the context. */
const INLINE_TEXT_LIMIT = 200_000;

const TEXT_MEDIA_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|sql)\b)/;
const TEXT_EXTENSIONS =
  /\.(md|markdown|txt|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|env|sh|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sql|html?|css|scss|less|jsx?|tsx?|mjs|cjs|vue|svelte|diff|patch)$/i;

export function isTextAttachment(part: Pick<FileUIPart, "mediaType" | "filename">): boolean {
  return TEXT_MEDIA_TYPES.test(part.mediaType) || (part.filename != null && TEXT_EXTENSIONS.test(part.filename));
}

/** What the model can take as a file part as is. */
const isModelReadable = (mediaType: string): boolean => mediaType.startsWith("image/") || mediaType === "application/pdf";

/** The bytes behind a `data:` URL, or `undefined` for any other URL. */
export function decodeDataUrl(url: string): Uint8Array | undefined {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url);
  if (match == null) return undefined;
  const payload = match[3] ?? "";
  return (match[2] ?? "").includes(";base64")
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : new TextEncoder().encode(decodeURIComponent(payload));
}

/** A file name that is safe as one path segment, and still recognisable. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "")
    .replace(/[/\\:]/g, "_")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned === "" ? fallback : cleaned.slice(-120);
}

export interface AttachmentOptions {
  engine: EngineId;
  /** `<dataDir>/attachments/<threadId>` — where a harness engine's copies go. */
  dir: string;
}

/**
 * The history as this engine can take it. Returns the same array when no user
 * message carries a file, so the common case costs one scan.
 */
export async function prepareAttachments(messages: UIMessage[], options: AttachmentOptions): Promise<UIMessage[]> {
  const hasFile = (message: UIMessage): boolean => message.role === "user" && message.parts.some((part) => part.type === "file");
  if (!messages.some(hasFile)) return messages;

  const asPaths = options.engine !== "vgent";
  let made = false;
  const next: UIMessage[] = [];
  for (const message of messages) {
    if (!hasFile(message)) {
      next.push(message);
      continue;
    }
    const parts: UIMessage["parts"] = [];
    for (const [index, part] of message.parts.entries()) {
      if (part.type !== "file") {
        parts.push(part);
        continue;
      }
      const name = safeFileName(part.filename, `attachment-${index}`);
      const bytes = decodeDataUrl(part.url);
      if (bytes == null) {
        parts.push({ type: "text", text: `[附件 ${name}：${part.url}]` });
      } else if (asPaths) {
        if (!made) {
          await mkdir(options.dir, { recursive: true });
          made = true;
        }
        // Keyed by message and position, so a later turn rewrites the same file rather than piling up copies.
        const path = join(options.dir, `${safeFileName(message.id, "message")}-${index}-${name}`);
        await writeFile(path, bytes);
        parts.push({ type: "text", text: `[附件 ${name}（${part.mediaType}）已保存到 ${path} ，需要时用读文件的工具查看]` });
      } else if (isModelReadable(part.mediaType)) {
        parts.push(part);
      } else if (isTextAttachment(part)) {
        const text = new TextDecoder().decode(bytes);
        const cut = text.length > INLINE_TEXT_LIMIT;
        parts.push({
          type: "text",
          text: `附件 ${name}${cut ? `（只取了前 ${INLINE_TEXT_LIMIT} 个字符）` : ""}：\n\`\`\`\n${cut ? text.slice(0, INLINE_TEXT_LIMIT) : text}\n\`\`\``,
        });
      } else {
        parts.push({ type: "text", text: `[附件 ${name}（${part.mediaType}）：这种文件这个引擎读不了]` });
      }
    }
    next.push({ ...message, parts });
  }
  return next;
}
