import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Copy, Download, ImageIcon } from "lucide-react";
import { Image } from "@/components/ai-elements/image";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useFileAccess, type PictureData } from "@/features/files/fileAccess";
import { copyPicture } from "@/lib/copyPicture";
import { svgFrame } from "@/lib/preview";
import { cn } from "@/lib/utils";

const FRAME = "max-h-figure w-auto max-w-full rounded-lg border border-border object-contain shadow-xs";
const DOWNLOAD =
  "absolute top-xs right-xs grid size-xl place-items-center rounded-md border border-border bg-bg-elevated text-fg-muted shadow-xs hover:text-fg";

/** AI Elements' `Image` takes a generated file; the bytes it never reads are left empty. */
const asFile = (picture: PictureData) => ({ ...picture, uint8Array: new Uint8Array() });

function textOf(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Width and height attributes plus the aspect, so the box exists before the SVG decodes. */
function frameProps(frame: { width: number; height: number }): { width: number; height: number; style: CSSProperties } {
  return {
    width: frame.width,
    height: frame.height,
    style: {
      aspectRatio: `${frame.width} / ${frame.height}`,
      width: `min(100%, calc(var(--spacing-figure) * ${frame.width} / ${frame.height}))`,
      height: "auto",
      maxHeight: "var(--spacing-figure)",
    },
  };
}

/**
 * Right click on a picture. The web view's own menu is no use here — its Copy
 * Image does nothing for an SVG, and its 下载 and 新窗口 go nowhere in the
 * desktop app — so this one takes its place: the two things that work.
 */
function PictureMenu({ picture, onDownload, children }: { picture: PictureData; onDownload?: (() => void) | undefined; children: ReactNode }) {
  const notify = useFileAccess()?.notify;
  const copy = () => {
    copyPicture(picture).then(
      () => notify?.("已复制图片"),
      () => notify?.("复制不了这张图"),
    );
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={copy}>
          <Copy />
          复制图片
        </ContextMenuItem>
        {onDownload != null && (
          <ContextMenuItem onSelect={onDownload}>
            <Download />
            下载
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The one way a picture is shown in the log, whatever it came from: small, as
 * AI Elements' `Image`, with nothing around it. Clicking it opens the same
 * picture large, over the window; 下载 sits in the corner of both.
 */
export function Figure({
  picture,
  alt,
  note,
  pending = false,
  onDownload,
}: {
  /** Absent while loading or when the picture cannot be shown; `note` says which. */
  picture?: PictureData;
  alt: string;
  note?: string;
  /** The picture is loading or being drawn, as opposed to not showable at all. */
  pending?: boolean;
  onDownload?: () => void;
}) {
  // A picture still on its way holds its room: the desktop web view has no scroll
  // anchoring, so a line that later grows into a picture shoves everything under it down.
  if (picture == null && pending) {
    return (
      <span className="my-xs grid h-figure w-[min(100%,calc(var(--spacing-figure)*1.25))] place-items-center rounded-lg bg-bg-inset text-fg-faint text-sm">
        {note}
      </span>
    );
  }
  if (picture == null) return <span className="my-xs inline-block rounded-md bg-bg-inset px-xs py-3xs text-fg-faint text-sm">{note}</span>;
  return <ReadyFigure picture={picture} alt={alt} {...(onDownload != null ? { onDownload } : {})} />;
}

function ReadyFigure({
  picture,
  alt,
  onDownload,
}: {
  picture: PictureData;
  alt: string;
  onDownload?: () => void;
}) {
  const frame = useMemo(() => {
    if (picture.mediaType !== "image/svg+xml") return undefined;
    try {
      return svgFrame(textOf(picture.base64));
    } catch {
      return undefined;
    }
  }, [picture.base64, picture.mediaType]);
  const download = (className?: string) =>
    onDownload != null && (
      <button type="button" aria-label="下载" title="下载" onClick={onDownload} className={cn(DOWNLOAD, className)}>
        <Download className="size-md" />
      </button>
    );
  return (
    <Dialog>
      <span className="group/figure relative my-xs inline-block max-w-full align-top">
        <PictureMenu picture={picture} onDownload={onDownload}>
          <DialogTrigger asChild>
            <button type="button" className="block max-w-full cursor-zoom-in">
              <Image {...asFile(picture)} alt={alt} className={FRAME} {...(frame != null ? frameProps(frame) : {})} />
            </button>
          </DialogTrigger>
        </PictureMenu>
        {download("opacity-0 focus-visible:opacity-100 group-hover/figure:opacity-100")}
      </span>
      <PictureDialogContent picture={picture} alt={alt} {...(onDownload != null ? { onDownload } : {})} />
    </Dialog>
  );
}

/** A width the WebView can resolve before sizing its max-width image. `w-auto` collapses this grid and the image to zero. */
export function PictureDialogContent({
  picture,
  alt,
  note,
  onDownload,
}: {
  picture?: PictureData;
  alt: string;
  note?: string;
  onDownload?: () => void;
}) {
  return (
    <DialogContent showCloseButton={false} className="w-[min(92vw,900px)] max-w-[92vw] place-items-center gap-0 border-border bg-bg-elevated p-xs sm:max-w-[92vw]">
      <DialogTitle className="sr-only">{alt === "" ? "图片" : alt}</DialogTitle>
      <DialogDescription className="sr-only">放大查看；点外面或按 Esc 关闭</DialogDescription>
      {picture == null ? (
        <span className="grid min-h-figure place-items-center text-fg-muted">{note}</span>
      ) : (
        <PictureMenu picture={picture} onDownload={onDownload}>
          <Image {...asFile(picture)} alt={alt} className="max-h-[88vh] w-auto max-w-full rounded-md object-contain" />
        </PictureMenu>
      )}
      {picture != null && onDownload != null && (
        <button type="button" aria-label="下载" title="下载" onClick={onDownload} className={DOWNLOAD}>
          <Download className="size-md" />
        </button>
      )}
    </DialogContent>
  );
}

/** A picture already available by URL, including a sent attachment's data URL. */
export function UrlFigure({
  src,
  alt,
  thumbnailClassName,
  wrapperClassName,
}: {
  src: string;
  alt: string;
  thumbnailClassName?: string;
  wrapperClassName?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" aria-label={`查看${alt || "图片"}`} className={cn("my-xs inline-block max-w-full cursor-zoom-in align-top", wrapperClassName)}>
          <img src={src} alt={alt} referrerPolicy="no-referrer" className={cn(FRAME, thumbnailClassName)} />
        </button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="w-[min(92vw,900px)] max-w-[92vw] place-items-center gap-0 border-border bg-bg-elevated p-xs sm:max-w-[92vw]">
        <DialogTitle className="sr-only">{alt || "图片"}</DialogTitle>
        <DialogDescription className="sr-only">放大查看；点外面或按 Esc 关闭</DialogDescription>
        <img src={src} alt={alt} referrerPolicy="no-referrer" className="max-h-[88vh] w-auto max-w-full rounded-md object-contain" />
      </DialogContent>
    </Dialog>
  );
}

/** Only ever resolved against, to tell an address that names a server from one that stays on this page's own. */
const PAGE = new URL("http://page.invalid/");

/**
 * The server an image would be fetched from — `undefined` when showing it makes
 * no request to anyone else: a `data:` or `blob:` picture, or a path on this
 * page's own origin.
 */
export function externalHost(src: string): string | undefined {
  const value = src.trim();
  if (/^(?:data|blob):/i.test(value)) return undefined;
  try {
    const url = new URL(value, PAGE);
    if (url.origin === PAGE.origin) return undefined;
    return url.host === "" ? url.protocol : url.host;
  } catch {
    // What the URL parser rejects, the browser does not fetch either.
    return undefined;
  }
}

/** Pictures asked for during this visit: a remount (a folded log opening again) must not ask twice. */
const LOADED = new Set<string>();

/**
 * The web's own picture: same frame, shown straight from where it lives — once
 * asked for. Fetching it is a request to a server the model picked, and the
 * address itself can carry anything the model has read (`![](https://x/?d=…)`),
 * so nothing is requested until the reader clicks.
 */
export function RemoteFigure({ src, alt }: { src: string; alt: string }) {
  const host = externalHost(src);
  const [asked, setAsked] = useState(() => LOADED.has(src));
  if (host == null || asked) return <UrlFigure src={src} alt={alt} />;
  return (
    <button
      type="button"
      title={src}
      aria-label={`加载外部图片：${host}`}
      onClick={() => {
        LOADED.add(src);
        setAsked(true);
      }}
      className="my-xs inline-flex max-w-full items-center gap-xs rounded-md border border-border bg-bg-inset px-xs py-3xs text-fg-muted text-sm hover:text-fg"
    >
      <ImageIcon className="size-md shrink-0" />
      <span className="truncate">{host}</span>
    </button>
  );
}
