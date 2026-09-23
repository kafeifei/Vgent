import type { FileUIPart } from "ai";
import type { DraftAttachment } from "@/lib/drafts";

/**
 * A file the user picked, pasted or dropped, waiting in the composer to go out
 * with the next message. It is part of the draft, so it survives a task switch
 * and a relaunch like the text does.
 */
export type Attachment = DraftAttachment;

/**
 * Per file. The message travels as JSON and is stored in the thread's file, so
 * this is a ceiling on how much one message may weigh, not a format limit.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const isImage = (mediaType: string): boolean => mediaType.startsWith("image/");

/** `12 KB` / `3.4 MB`, for the tile and the refusal toast. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits a batch into what can ride along and the names of what is too big to. */
export function partitionBySize<T extends { name: string; size: number }>(
  files: readonly T[],
  limit = MAX_ATTACHMENT_BYTES,
): { accepted: T[]; rejected: string[] } {
  const accepted = files.filter((file) => file.size <= limit);
  return { accepted, rejected: files.filter((file) => file.size > limit).map((file) => file.name) };
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`读不了 ${file.name}`));
    reader.readAsDataURL(file);
  });

/** Reads the files that fit; the names of the ones that do not come back for the caller to report. */
export async function readAttachments(files: readonly File[]): Promise<{ attachments: Attachment[]; rejected: string[] }> {
  const { accepted, rejected } = partitionBySize(files);
  const attachments = await Promise.all(
    accepted.map(async (file) => ({
      id: crypto.randomUUID(),
      // A pasted screenshot arrives as `image.png`; a file with no name at all still needs one.
      name: file.name === "" ? "附件" : file.name,
      mediaType: file.type === "" ? "application/octet-stream" : file.type,
      url: await readAsDataUrl(file),
      size: file.size,
    })),
  );
  return { attachments, rejected };
}

/** The attachments as the `file` parts `chat.sendMessage({ files })` takes. */
export const toFileParts = (attachments: readonly Attachment[]): FileUIPart[] =>
  attachments.map((entry) => ({ type: "file", mediaType: entry.mediaType, filename: entry.name, url: entry.url }));
