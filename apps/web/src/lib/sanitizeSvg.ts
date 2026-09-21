import DOMPurify from "dompurify";
import { svgDataUri } from "./preview";

/**
 * SVG source → what an `<img>` may show. The image context already runs no
 * script; stripping `<script>` and `<foreignObject>` first means the source
 * someone copies out of the preview is clean too.
 */
export function cleanSvg(source: string): string | undefined {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["use"],
    FORBID_TAGS: ["script", "foreignObject"],
  }).trim();
  return /<svg[\s>]/i.test(clean) ? clean : undefined;
}

export function svgPictureOf(source: string): string | undefined {
  const clean = cleanSvg(source);
  return clean == null ? undefined : svgDataUri(clean);
}
