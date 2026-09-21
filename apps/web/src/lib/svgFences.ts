/**
 * Bare `<svg>…</svg>` in a reply → a fenced `svg` block.
 *
 * Asked to draw something, a model pastes the markup straight into its reply
 * about as often as it fences it. Left alone, the markdown pipeline takes it
 * for raw HTML and sanitizes it down to its `<title>` text: the work was done
 * and nothing shows. Fenced, it goes where every other drawing goes — shown as
 * a picture, source one click away — and a drawing still streaming is an open
 * fence, which the renderer already treats as「正在画…」.
 *
 * Code, fenced or inline, is left exactly as written.
 */
const PROTECTED = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
/** An optional XML prolog and doctype ride along with the drawing they introduce. */
const PROLOG = "(?:<\\?xml[^>]*\\?>\\s*)?(?:<!DOCTYPE[^>]*>\\s*)?";
const COMPLETE = new RegExp(`${PROLOG}<svg\\b[\\s\\S]*?<\\/svg\\s*>`, "gi");
const OPENED = new RegExp(`${PROLOG}<svg\\b[\\s\\S]*$`, "i");

const fence = (svg: string, closed: boolean): string => `\n\n\`\`\`svg\n${svg.trim()}\n${closed ? "```\n\n" : ""}`;

export function fenceBareSvg(text: string): string {
  if (!/<svg\b/i.test(text)) return text;
  const chunks = text.split(PROTECTED);
  return chunks
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk;
      const fenced = chunk.replace(COMPLETE, (svg) => fence(svg, true));
      // Only the very end of the reply can still be streaming.
      if (index !== chunks.length - 1) return fenced;
      const tail = fenced.lastIndexOf("```\n\n") + 5;
      const rest = fenced.slice(Math.max(tail, 0));
      return fenced.slice(0, Math.max(tail, 0)) + rest.replace(OPENED, (svg) => fence(svg, false));
    })
    .join("")
    .replace(/^\n+/, "");
}
