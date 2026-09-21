import { createContext, useContext, useEffect, useState } from "react";
import type { ApiClient } from "@/lib/api";
import { previewKindOf, svgForImage, toBase64 } from "@/lib/preview";

/**
 * How anything inside a task's view reaches that task's files: the markdown in
 * a reply, the cards under a turn, the file viewer. Absent outside a task, and
 * then a local path is simply a picture that cannot be shown.
 */
export interface FileAccess {
  client: Pick<ApiClient, "getFileBlob" | "resolveFiles" | "downloadFile">;
  threadId: string;
  /** The thread's `updatedAt`: a new one means the engine may have rewritten the file. */
  refreshKey: string;
  /** Show this file in the right pane. */
  openFile: (path: string) => void;
  /** Says where a download landed, or why it did not. */
  notify?: (message: string) => void;
  /** Where a relative path starts from: the directory of the document being shown. The task's root when absent. */
  baseDir?: string;
}

const FileAccessContext = createContext<FileAccess | null>(null);

export const FileAccessProvider = FileAccessContext.Provider;

export function useFileAccess(): FileAccess | null {
  return useContext(FileAccessContext);
}

/** 「下载」: a copy in the Downloads folder. What it is then opened with is the user's call. */
export function download(access: FileAccess, content: { path: string } | { svg: string }): void {
  access.client.downloadFile(access.threadId, content).then(
    ({ savedTo }) => access.notify?.(`已保存到 ${savedTo}`),
    (failure: unknown) => access.notify?.(failure instanceof Error ? failure.message : String(failure)),
  );
}

/** A document's own relative paths start at the document, not at the root. */
export function fromBase(baseDir: string | undefined, path: string): string {
  if (baseDir == null || baseDir === "" || path.startsWith("/")) return path;
  const segments = baseDir.split("/");
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** What AI Elements' `Image` shows: the bytes and what they are. */
export interface PictureData {
  base64: string;
  mediaType: string;
}

export type FilePicture = { status: "loading" } | { status: "ready"; picture: PictureData } | { status: "unavailable" };

/** A drawing's source as picture data; `undefined` when it is not SVG. */
export function drawingPicture(svg: string): PictureData | undefined {
  const source = svgForImage(svg);
  return source == null ? undefined : { base64: toBase64(new TextEncoder().encode(source)), mediaType: "image/svg+xml" };
}

/**
 * One of the task's files as picture data. The bytes are fetched with the
 * token — an `<img>` cannot carry one. A file rewritten under a picture swaps
 * in when the new bytes arrive, without a blank frame in between.
 */
export function useFilePicture(path: string | undefined): FilePicture {
  const access = useFileAccess();
  const [picture, setPicture] = useState<FilePicture>({ status: "loading" });
  const client = access?.client;
  const threadId = access?.threadId;
  const refreshKey = access?.refreshKey;

  useEffect(() => {
    if (client == null || threadId == null || path == null) {
      setPicture({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    client
      .getFileBlob(threadId, path)
      .then(async (blob): Promise<PictureData | undefined> =>
        previewKindOf(path) === "svg"
          ? drawingPicture(await blob.text())
          : { base64: toBase64(new Uint8Array(await blob.arrayBuffer())), mediaType: blob.type || "application/octet-stream" },
      )
      .then(
        (data) => {
          if (!cancelled) setPicture(data == null ? { status: "unavailable" } : { status: "ready", picture: data });
        },
        () => {
          if (!cancelled) setPicture({ status: "unavailable" });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [client, threadId, path, refreshKey]);

  return picture;
}
