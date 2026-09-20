import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { useFileAccess, useFilePicture } from "@/features/files/fileAccess";
import { baseName } from "@/lib/format";
import { previewKindOf } from "@/lib/preview";
import { outputCandidates } from "./outputs";
import type { Block } from "./turns";

function Thumbnail({ path }: { path: string }) {
  const picture = useFilePicture(path);
  if (picture.status !== "ready") return <span className="size-3xl flex-none rounded-sm bg-bg-inset" />;
  return <img src={picture.src} alt="" className="size-3xl flex-none rounded-sm bg-bg-inset object-contain" />;
}

/**
 * What a finished turn made that can be looked at: a row of cards under the
 * reply, each opening the file in the right pane. The candidates come from the
 * turn itself; the server says which of them are files of this task right now,
 * so a name the model merely mentioned never becomes a dead card.
 */
export function TurnOutputs({ blocks }: { blocks: readonly Block[] }) {
  const access = useFileAccess();
  const candidates = useMemo(() => outputCandidates(blocks), [blocks]);
  const wanted = candidates.join("\n");
  const [paths, setPaths] = useState<string[]>([]);
  const client = access?.client;
  const threadId = access?.threadId;

  useEffect(() => {
    if (client == null || threadId == null || wanted === "") {
      setPaths([]);
      return;
    }
    let cancelled = false;
    client.resolveFiles(threadId, wanted.split("\n")).then(
      (found) => {
        if (!cancelled) setPaths([...new Set(found.map((file) => file.path))]);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, threadId, wanted]);

  if (access == null || paths.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-xs px-chat-inset">
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          title={path}
          onClick={() => access.openFile(path)}
          className="flex max-w-full items-center gap-xs rounded-lg border border-border bg-bg-elevated p-2xs pr-sm text-left hover:border-border-strong hover:bg-bg-hover"
        >
          {previewKindOf(path) === "markdown" ? (
            <span className="grid size-3xl flex-none place-items-center rounded-sm bg-bg-inset">
              <FileText className="size-lg text-fg-muted" />
            </span>
          ) : (
            <Thumbnail path={path} />
          )}
          <span className="min-w-0 truncate font-mono text-code text-fg">{baseName(path)}</span>
        </button>
      ))}
    </div>
  );
}
