import { localPathOf, previewKindOf } from "@/lib/preview";
import { describeTool } from "./toolMeta";
import type { Block } from "./turns";

/** More cards than this under one reply is a directory listing, not a result. */
const MAX_OUTPUTS = 12;

const LINK = /!?\[[^\]]*\]\(\s*<?([^)>\s]+(?: [^)>\s]+)*)>?(?:\s+"[^"]*")?\s*\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** The files a reply names: what its links and images point at, and any `inline code` that reads as a file name. */
function namedIn(text: string): string[] {
  const prose = text.replace(FENCE, "");
  const named: string[] = [];
  for (const match of prose.matchAll(LINK)) {
    // An image is already on screen where the reply put it.
    if (match[0].startsWith("!")) continue;
    const path = localPathOf(match[1] ?? "");
    if (path != null) named.push(path);
  }
  for (const match of prose.matchAll(INLINE_CODE)) {
    const span = (match[1] ?? "").trim();
    if (!/\s/.test(span) && previewKindOf(span) != null) named.push(span);
  }
  return named;
}

/**
 * What a finished turn may have produced that is worth looking at, as the
 * turn wrote it — the server still has to say which of these are files of the
 * task. Two sources, because no single one covers every engine: the write and
 * edit calls (Claude Code and Vgent report them; Codex patches files without a
 * call of its own), and the reply, where every engine says what it made.
 *
 * A picture counts wherever it came from. A document only counts when the
 * reply names it: a turn that touched five READMEs did not produce five results.
 */
export function outputCandidates(blocks: readonly Block[]): string[] {
  const written: string[] = [];
  const named: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") named.push(...namedIn(block.part.text));
    else if (block.kind === "tool" && block.part.state === "output-available") {
      const file = describeTool(block.part).file;
      if (file != null) written.push(file);
    }
  }
  const pictures = written.filter((path) => {
    const kind = previewKindOf(path);
    return kind === "image" || kind === "svg";
  });
  const candidates = [...pictures, ...named.filter((path) => previewKindOf(path) != null)];
  return [...new Set(candidates)].slice(0, MAX_OUTPUTS);
}
