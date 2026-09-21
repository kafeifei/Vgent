import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ApiClient } from "@/lib/api";
import { previewKindOf } from "@/lib/preview";
import { svgPictureOf } from "@/lib/sanitizeSvg";

/**
 * How anything inside a task's view reaches that task's files: the markdown in
 * a reply, the cards under a turn, the file viewer. Absent outside a task, and
 * then a local path is simply a picture that cannot be shown.
 */
export interface FileAccess {
  client: Pick<ApiClient, "getFileBlob" | "resolveFiles" | "registerTicket">;
  threadId: string;
  /** The thread's `updatedAt`: a new one means the engine may have rewritten the file. */
  refreshKey: string;
  /** Show this file in the right pane. */
  openFile: (path: string) => void;
  /** Show a drawing that exists only in a reply in the right pane. Absent where there is no pane to open. */
  openDrawing?: (svg: string) => void;
  /** Where a relative path starts from: the directory of the document being shown. The task's root when absent. */
  baseDir?: string;
}

const FileAccessContext = createContext<FileAccess | null>(null);

export const FileAccessProvider = FileAccessContext.Provider;

export function useFileAccess(): FileAccess | null {
  return useContext(FileAccessContext);
}

/**
 * 「在浏览器打开」 for something only this task can serve. The window has to open
 * in the same tick as the click — after an `await` it is a blocked popup — so
 * the address is made up here, opened at once, and only then registered; the
 * server holds the browser's request until it is. In the desktop shell the new
 * window is handed to the system browser.
 */
export function openInBrowser(access: FileAccess, content: { path: string } | { svg: string }): void {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const ticket = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  window.open(`${window.location.origin}/api/tickets/${ticket}`, "_blank", "noreferrer");
  void access.client.registerTicket(access.threadId, ticket, content).catch(() => undefined);
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

export type FilePicture = { status: "loading" } | { status: "ready"; src: string } | { status: "unavailable" };

/**
 * An `<img src>` for one of the task's files. The bytes are fetched with the
 * token — an `<img>` cannot carry one — and an SVG goes through the sanitizer
 * into a data URI rather than a blob, so it is an image by construction.
 */
export function useFilePicture(path: string | undefined): FilePicture {
  const access = useFileAccess();
  const [picture, setPicture] = useState<FilePicture>({ status: "loading" });
  const client = access?.client;
  const threadId = access?.threadId;
  const refreshKey = access?.refreshKey;

  /** The blob URL on screen. It outlives a refetch, so a rewritten file swaps in without a blank frame. */
  const shown = useRef<string | undefined>(undefined);
  const release = (): void => {
    if (shown.current != null) URL.revokeObjectURL(shown.current);
    shown.current = undefined;
  };
  useEffect(() => release, []);

  useEffect(() => {
    if (client == null || threadId == null || path == null) {
      setPicture({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    client
      .getFileBlob(threadId, path)
      .then(async (blob): Promise<Blob | string | undefined> => (previewKindOf(path) === "svg" ? svgPictureOf(await blob.text()) : blob))
      .then(
        (loaded) => {
          if (cancelled) return;
          release();
          if (loaded instanceof Blob) shown.current = URL.createObjectURL(loaded);
          const src = loaded instanceof Blob ? shown.current : loaded;
          setPicture(src == null ? { status: "unavailable" } : { status: "ready", src });
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
