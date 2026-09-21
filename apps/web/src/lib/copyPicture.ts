/** The longest side a copied drawing is rendered at: an SVG has no pixels of its own, and a small one pastes as a smudge. */
const DRAWING_SIDE = 2048;
/** What an SVG that declares no size at all is taken to be. */
const FALLBACK_SIDE = 1024;

/** The pixel size a picture is copied at. A bitmap keeps its own; a drawing is scaled up to `DRAWING_SIDE`. */
export function copySize(natural: { width: number; height: number }, drawing: boolean): { width: number; height: number } {
  const width = natural.width > 0 ? natural.width : FALLBACK_SIDE;
  const height = natural.height > 0 ? natural.height : FALLBACK_SIDE;
  if (!drawing) return { width, height };
  const scale = DRAWING_SIDE / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function asPng(picture: { base64: string; mediaType: string }): Promise<Blob> {
  const image = new Image();
  image.src = `data:${picture.mediaType};base64,${picture.base64}`;
  await image.decode();
  const size = copySize({ width: image.naturalWidth, height: image.naturalHeight }, picture.mediaType === "image/svg+xml");
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context == null) throw new Error("no canvas");
  context.drawImage(image, 0, 0, size.width, size.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob == null ? reject(new Error("no bitmap")) : resolve(blob)), "image/png"));
}

/**
 * 复制图片. The system's own Copy Image does nothing for an SVG, and the
 * clipboard only reliably takes PNG, so every picture goes in as one. The item
 * is handed the promise rather than the blob: WebKit only allows a clipboard
 * write inside the click itself, and drawing the bitmap takes longer than that.
 */
export function copyPicture(picture: { base64: string; mediaType: string }): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ "image/png": asPng(picture) })]);
}
