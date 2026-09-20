/**
 * `\(…\)` and `\[…\]` → the `$$` forms the markdown math parser takes.
 *
 * Models write LaTeX's own delimiters about as often as dollars. A single `$`
 * stays off — `$5 and $10` is not a formula — so inline math is `$$…$$` on one
 * line, and display math is `$$` on lines of its own. Code, fenced or inline,
 * is left exactly as written.
 */
const PROTECTED = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;
const DISPLAY = /\\\[([\s\S]+?)\\\]/g;
const INLINE = /\\\(([^\n]+?)\\\)/g;

function convert(text: string): string {
  return text
    .replace(DISPLAY, (_, body: string) => `\n$$\n${body.trim()}\n$$\n`)
    .replace(INLINE, (_, body: string) => `$$${body.trim()}$$`);
}

export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  return text
    .split(PROTECTED)
    .map((chunk, index) => (index % 2 === 1 ? chunk : convert(chunk)))
    .join("");
}
