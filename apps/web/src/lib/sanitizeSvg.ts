import DOMPurify from "dompurify";
import { svgDataUri } from "./preview";

/**
 * SVG source → what an `<img>` may show. The image context already runs no
 * script; stripping `<script>` and `<foreignObject>` first means the source
 * someone copies out of the preview is clean too.
 */
export function svgPictureOf(source: string): string | undefined {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["use"],
    FORBID_TAGS: ["script", "foreignObject"],
  }).trim();
  const uri = svgDataUri(clean);
  return uri === "" ? undefined : uri;
}
