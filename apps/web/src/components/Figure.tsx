import { Code2, Globe, Image as ImageIcon, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from "@/components/ai-elements/artifact";

/**
 * The one way a picture is shown in the log, whatever it came from — a file of
 * the task, a drawing fenced or pasted into a reply, an image off the web. It
 * is AI Elements' `Artifact`: a frame with a title bar and actions, here at a
 * size that never takes over the conversation. Clicking the picture opens it
 * large in the right pane; the globe opens it in the system browser.
 */
export function Figure({
  title,
  src,
  alt,
  note,
  onOpenSide,
  onOpenBrowser,
  source,
}: {
  title: string;
  /** Absent while loading or when the picture cannot be shown; `note` says which. */
  src?: string;
  alt: string;
  note?: string;
  onOpenSide?: () => void;
  onOpenBrowser?: () => void;
  /** 预览 ⇄ 源码, for a drawing that has source. `body` replaces the picture while on. */
  source?: { on: boolean; onToggle: () => void; body: ReactNode };
}) {
  return (
    <Artifact className="my-xs border-border bg-bg-elevated shadow-none">
      <ArtifactHeader className="h-xl gap-xs border-border bg-transparent px-xs py-0">
        <span className="flex min-w-0 items-center gap-2xs">
          <ImageIcon className="size-md flex-none text-fg-faint" />
          <ArtifactTitle className="truncate font-mono font-normal text-code text-fg-muted">{title}</ArtifactTitle>
        </span>
        <ArtifactActions className="flex-none gap-0">
          {source != null && (
            <ArtifactAction
              icon={Code2}
              tooltip={source.on ? "预览" : "源码"}
              aria-pressed={source.on}
              onClick={source.onToggle}
              className="size-lg aria-pressed:text-fg"
            />
          )}
          {onOpenSide != null && <ArtifactAction icon={PanelRight} tooltip="在右栏打开" onClick={onOpenSide} className="size-lg" />}
          {onOpenBrowser != null && <ArtifactAction icon={Globe} tooltip="在浏览器打开" onClick={onOpenBrowser} className="size-lg" />}
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent className={source?.on === true ? "max-h-figure p-0" : "grid min-h-3xl place-items-center bg-bg-inset p-sm"}>
        {source?.on === true ? (
          source.body
        ) : src == null ? (
          <span className="text-fg-faint text-sm">{note}</span>
        ) : onOpenSide != null ? (
          <button type="button" onClick={onOpenSide} className="block max-w-full cursor-zoom-in">
            <img src={src} alt={alt} className="max-h-figure max-w-full object-contain" />
          </button>
        ) : (
          <img src={src} alt={alt} referrerPolicy="no-referrer" className="max-h-figure max-w-full object-contain" />
        )}
      </ArtifactContent>
    </Artifact>
  );
}
