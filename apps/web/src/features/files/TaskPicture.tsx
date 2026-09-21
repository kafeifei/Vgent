import { Figure } from "@/components/Figure";
import { baseName } from "@/lib/format";
import { download, fromBase, useFileAccess, useFilePicture } from "./fileAccess";

/**
 * One of the task's own picture files, shown the way every picture in the log
 * is: `![](pelican.svg)` in a reply, and a picture the turn wrote to disk.
 */
export function TaskPicture({ path: written, alt }: { path: string; alt: string }) {
  const access = useFileAccess();
  const path = fromBase(access?.baseDir, written);
  const picture = useFilePicture(path);
  if (picture.status !== "ready") return <Figure alt={alt} note={picture.status === "loading" ? "图片加载中…" : `无法显示 ${baseName(path)}`} />;
  return (
    <Figure
      picture={picture.picture}
      alt={alt}
      {...(access != null ? { onDownload: () => download(access, { path }) } : {})}
    />
  );
}
