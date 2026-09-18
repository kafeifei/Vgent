/** The composer's `@路径` tokens: where one is being typed, and how it lands. */

export interface Mention {
  /** Offset of the `@` itself. */
  start: number;
  /** Offset just past the query — the caret, when the mention is live. */
  end: number;
  /** What was typed after the `@`; empty right after the `@`. */
  query: string;
}

/** Every `@path` token, as the mirror layer paints them. */
const TOKEN = /@[^\s@]+/g;

/**
 * The `@…` the caret sits at the end of, or `null`.
 *
 * A mention only starts at the beginning of the text or after whitespace, so a
 * mail address or a `foo@bar` never opens the popover.
 */
export function findMention(text: string, caret: number): Mention | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (match == null) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}

/** Swaps the mention for `@<path>` plus a separating space; a dir keeps a `/`. */
export function acceptMention(
  text: string,
  mention: Mention,
  entry: { path: string; kind: "file" | "dir" },
): { text: string; caret: number } {
  const rest = text.slice(mention.end);
  // The caller may be editing mid-text, where the space is already there.
  const token = `@${entry.path}${entry.kind === "dir" ? "/" : ""}${/^\s/.test(rest) ? "" : " "}`;
  return { text: text.slice(0, mention.start) + token + rest, caret: mention.start + token.length };
}

/** Splits the text into plain runs and `@path` runs, in order. */
export function mentionSegments(text: string): Array<{ text: string; mention: boolean }> {
  const segments: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), mention: false });
    segments.push({ text: match[0], mention: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mention: false });
  return segments;
}
