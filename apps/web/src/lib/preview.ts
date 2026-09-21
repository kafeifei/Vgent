/**
 * What a file is shown as. A picture is shown as a picture and a document as a
 * document; everything else is text in the code viewer.
 *
 * SVG is its own kind because it is both: drawn by default, with its source one
 * click away. It is only ever drawn through an `<img>` on a data URI — an image
 * context runs no script, fires no handler and fetches nothing external.
 */
export type PreviewKind = "image" | "svg" | "markdown";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function previewKindOf(path: string): PreviewKind | undefined {
  const extension = extensionOf(path);
  if (extension === "svg") return "svg";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return undefined;
}

/** Whether a fenced block is a drawing: tagged `svg`, or tagged `xml`/`html` and starting with `<svg`. */
export function isSvgFence(language: string, code: string): boolean {
  const tag = language.toLowerCase();
  if (tag === "svg") return true;
  if (tag !== "xml" && tag !== "html") return false;
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(code);
}

/**
 * SVG source as an image can take it, or `undefined` when there is no `<svg`
 * in it. The namespace is added when the model left it out — an image needs
 * it, inline HTML did not. Nothing else is touched: an `<img>` runs no script
 * whatever the markup says, so there is nothing to clean.
 */
export function svgForImage(svg: string): string | undefined {
  const open = svg.search(/<svg[\s>]/i);
  if (open < 0) return undefined;
  const body = svg.slice(open);
  const tag = body.slice(0, body.indexOf(">") + 1);
  return /\sxmlns\s*=/.test(tag) ? body : body.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/** An `<img src>` for SVG source; empty when it is not SVG. */
export function svgDataUri(svg: string): string {
  const source = svgForImage(svg);
  return source == null ? "" : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
}

/** Bytes → base64, in slices: spreading a whole file into `fromCharCode` overflows the stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * How a local path travels through the markdown pipeline. Its sanitizer drops
 * `file:` and blocks a bare relative URL outright, so a path is carried as a
 * root-relative URL of our own — which it lets through — and unpacked by
 * whatever renders the element.
 */
const TASK_FILE_PREFIX = "/__task_file__/";

export const taskFileUrl = (path: string): string => TASK_FILE_PREFIX + encodeURIComponent(path);

export function taskFileOf(url: string): string | undefined {
  if (!url.startsWith(TASK_FILE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(url.slice(TASK_FILE_PREFIX.length));
  } catch {
    return undefined;
  }
}

/**
 * The file a markdown image or link points at, when it points at one of the
 * task's own: `pelican.svg`, `./out/a.png`, `/Users/…/a.png`, `file:///…`.
 * Anything with another scheme is the web's and is left alone.
 */
export function localPathOf(src: string): string | undefined {
  const trimmed = src.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme != null && scheme !== "file") return undefined;
  const bare = (scheme === "file" ? trimmed.replace(/^file:\/\/(localhost)?/i, "") : trimmed).replace(/[?#].*$/, "");
  if (bare === "") return undefined;
  // Spaces and CJK arrive percent-encoded from a markdown parser, and raw from a model that did not bother.
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}
