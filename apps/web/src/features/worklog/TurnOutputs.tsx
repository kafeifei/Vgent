import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useFileAccess } from "@/features/files/fileAccess";
import { DrawnPicture, TaskPicture } from "@/features/files/TaskPicture";
import { baseName } from "@/lib/format";
import { previewKindOf } from "@/lib/preview";
import { drawingFor, outputCandidates, shownPicturePaths, visibleOutputFiles } from "./outputs";
import type { Block } from "./turns";

/**
 * What a finished turn made that can be looked at, under the reply. A picture
 * is shown as the picture — the same small figure a reply's own image gets,
 * opening large over the window, with 下载 — and its name under it opens the
 * same overlay. A document is a card that opens in the file pane. The candidates come from the
 * turn itself; the server says which of them are files of this task right now,
 * so a name the model merely mentioned never becomes a dead card.
 */
export function TurnOutputs({ blocks, drawings }: { blocks: readonly Block[]; drawings: ReadonlyMap<string, string> }) {
  const access = useFileAccess();
  const candidates = useMemo(() => outputCandidates(blocks), [blocks]);
  const shown = useMemo(() => shownPicturePaths(blocks), [blocks]);
  const wanted = candidates.length === 0 ? "" : [...new Set([...candidates, ...shown])].join("\n");
  const [found, setFound] = useState<readonly { raw: string; path: string }[]>([]);
  const client = access?.client;
  const threadId = access?.threadId;

  useEffect(() => {
    if (client == null || threadId == null || wanted === "") {
      setFound([]);
      return;
    }
    let cancelled = false;
    client.resolveFiles(threadId, wanted.split("\n")).then(
      (files) => {
        if (!cancelled) setFound(files);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, threadId, wanted]);

  const visible = useMemo(() => visibleOutputFiles(found, shown), [found, shown]);
  const paths = useMemo(() => [...new Set(visible.map((file) => file.path))], [visible]);
  // The drawing as this turn left it, not as the file is now: 「再来一次」 writes the same path again.
  const drawn = useMemo(() => {
    const byPath = new Map<string, string>();
    for (const file of visible) {
      const svg = drawingFor(drawings, file);
      if (svg != null) byPath.set(file.path, svg);
    }
    return byPath;
  }, [drawings, visible]);

  if (access == null || paths.length === 0) return null;
  const pictures = paths.filter((path) => previewKindOf(path) !== "markdown");
  const documents = paths.filter((path) => previewKindOf(path) === "markdown");
  return (
    <div className="flex flex-col gap-xs px-chat-inset">
      {pictures.map((path) => (
        <div key={path} className="flex flex-col items-start">
          {drawn.has(path) ? <DrawnPicture svg={drawn.get(path) as string} alt={baseName(path)} /> : <TaskPicture path={path} alt={baseName(path)} />}
          <button
            type="button"
            title={path}
            onClick={() => access.openFile(path)}
            className="max-w-full truncate font-mono text-code text-fg-muted hover:text-fg"
          >
            {baseName(path)}
          </button>
        </div>
      ))}
      {documents.length > 0 && (
        <div className="flex flex-wrap gap-xs">
          {documents.map((path) => (
            <button
              key={path}
              type="button"
              title={path}
              onClick={() => access.openFile(path)}
              className="flex max-w-full items-center gap-xs rounded-lg border border-border bg-bg-elevated p-2xs pr-sm text-left hover:border-border-strong hover:bg-bg-hover"
            >
              <span className="grid size-3xl flex-none place-items-center rounded-sm bg-bg-inset">
                <FileText className="size-lg text-fg-muted" />
              </span>
              <span className="min-w-0 truncate font-mono text-code text-fg">{baseName(path)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
