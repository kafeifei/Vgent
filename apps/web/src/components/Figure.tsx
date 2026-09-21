import type { ReactNode } from "react";
import { Copy, Download } from "lucide-react";
import { Image } from "@/components/ai-elements/image";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useFileAccess, type PictureData } from "@/features/files/fileAccess";
import { copyPicture } from "@/lib/copyPicture";
import { cn } from "@/lib/utils";

const FRAME = "max-h-figure w-auto max-w-full rounded-lg border border-border object-contain shadow-xs";
const DOWNLOAD =
  "absolute top-xs right-xs grid size-xl place-items-center rounded-md border border-border bg-bg-elevated text-fg-muted shadow-xs hover:text-fg";

/** AI Elements' `Image` takes a generated file; the bytes it never reads are left empty. */
const asFile = (picture: PictureData) => ({ ...picture, uint8Array: new Uint8Array() });

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
  onDownload,
}: {
  /** Absent while loading or when the picture cannot be shown; `note` says which. */
  picture?: PictureData;
  alt: string;
  note?: string;
  onDownload?: () => void;
}) {
  if (picture == null) return <span className="my-xs inline-block rounded-md bg-bg-inset px-xs py-3xs text-fg-faint text-sm">{note}</span>;
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
              <Image {...asFile(picture)} alt={alt} className={FRAME} />
            </button>
          </DialogTrigger>
        </PictureMenu>
        {download("opacity-0 focus-visible:opacity-100 group-hover/figure:opacity-100")}
      </span>
      <DialogContent
        showCloseButton={false}
        className="w-auto max-w-[92vw] gap-0 border-border bg-bg-elevated p-xs sm:max-w-[92vw]"
      >
        <DialogTitle className="sr-only">{alt === "" ? "图片" : alt}</DialogTitle>
        <DialogDescription className="sr-only">放大查看；点外面或按 Esc 关闭</DialogDescription>
        <PictureMenu picture={picture} onDownload={onDownload}>
          <Image {...asFile(picture)} alt={alt} className="max-h-[88vh] w-auto max-w-full rounded-md object-contain" />
        </PictureMenu>
        {download()}
      </DialogContent>
    </Dialog>
  );
}

/** The web's own picture: same frame, shown straight from where it lives. */
export function RemoteFigure({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} referrerPolicy="no-referrer" className={cn("my-xs", FRAME)} />;
}
