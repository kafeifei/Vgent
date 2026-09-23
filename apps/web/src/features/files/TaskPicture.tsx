import { useMemo } from "react";
import { Figure, PictureDialogContent } from "@/components/Figure";
import { Dialog } from "@/components/ui/dialog";
import { baseName } from "@/lib/format";
import { download, drawingPicture, fromBase, useFileAccess, useFilePicture } from "./fileAccess";

/**
 * One of the task's own picture files, shown the way every picture in the log
 * is: `![](pelican.svg)` in a reply, and a picture the turn wrote to disk.
 */
export function TaskPicture({ path: written, alt }: { path: string; alt: string }) {
  const access = useFileAccess();
  const path = fromBase(access?.baseDir, written);
  const picture = useFilePicture(path);
  if (picture.status === "loading") return <Figure alt={alt} note="图片加载中…" pending />;
  if (picture.status !== "ready") return <Figure alt={alt} note={`无法显示 ${baseName(path)}`} />;
  return (
    <Figure
      picture={picture.picture}
      alt={alt}
      {...(access != null ? { onDownload: () => download(access, { path }) } : {})}
    />
  );
}

/** A drawing we hold the source of — what a turn wrote, whatever the file says now. 下载 gives that source. */
export function DrawnPicture({ svg, alt }: { svg: string; alt: string }) {
  const access = useFileAccess();
  const picture = useMemo(() => drawingPicture(svg), [svg]);
  if (picture == null) return <Figure alt={alt} note={`无法显示 ${alt}`} />;
  return <Figure picture={picture} alt={alt} {...(access != null ? { onDownload: () => download(access, { svg }) } : {})} />;
}

/** Opens a task file over the whole window, including paths clicked in prose or tool rows. */
export function FilePictureDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const access = useFileAccess();
  const picture = useFilePicture(path);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PictureDialogContent
        {...(picture.status === "ready" ? { picture: picture.picture } : {})}
        alt={baseName(path)}
        note={picture.status === "loading" ? "图片加载中…" : `无法显示 ${baseName(path)}`}
        {...(access != null ? { onDownload: () => download(access, { path }) } : {})}
      />
    </Dialog>
  );
}
