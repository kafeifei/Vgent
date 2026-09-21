import { localPathOf, previewKindOf } from "@/lib/preview";
import { describeTool } from "./toolMeta";
import type { Block } from "./turns";

/** More cards than this under one reply is a directory listing, not a result. */
const MAX_OUTPUTS = 12;

const LINK = /!?\[[^\]]*\]\(\s*<?([^)>\s]+(?: [^)>\s]+)*)>?(?:\s+"[^"]*")?\s*\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** The files a reply points at with a link, and the ones it only mentions in `inline code`. */
function namedIn(text: string): { linked: string[]; mentioned: string[] } {
  const prose = text.replace(FENCE, "");
  const linked: string[] = [];
  const mentioned: string[] = [];
  for (const match of prose.matchAll(LINK)) {
    // An image is already on screen where the reply put it.
    if (match[0].startsWith("!")) continue;
    const path = localPathOf(match[1] ?? "");
    if (path != null) linked.push(path);
  }
  for (const match of prose.matchAll(INLINE_CODE)) {
    const span = (match[1] ?? "").trim();
    if (!/\s/.test(span) && previewKindOf(span) != null) mentioned.push(span);
  }
  return { linked, mentioned };
}

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Everything a tool call says about files: the path it was given, and a shell command's text. */
function touchedBy(part: Extract<Block, { kind: "tool" }>["part"]): string[] {
  const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as Record<string, unknown>;
  return [describeTool(part).file, input.path, input.file_path, input.command].filter((value): value is string => typeof value === "string");
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
 * And a name the reply merely mentions in passing — "there is an untracked
 * `pelican.svg`, I left it alone" — counts only when the turn did something
 * with that file; a link is the reply pointing at it, and always counts.
 */
export function outputCandidates(blocks: readonly Block[]): string[] {
  const written: string[] = [];
  const touched: string[] = [];
  const linked: string[] = [];
  const mentioned: string[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      const named = namedIn(block.part.text);
      linked.push(...named.linked);
      mentioned.push(...named.mentioned);
    } else if (block.kind === "tool" && block.part.state === "output-available") {
      const file = describeTool(block.part).file;
      if (file != null) written.push(file);
      touched.push(...touchedBy(block.part));
    }
  }
  const pictures = written.filter((path) => {
    const kind = previewKindOf(path);
    return kind === "image" || kind === "svg";
  });
  const made = mentioned.filter((path) => touched.some((text) => text.includes(fileName(path))));
  const candidates = [...pictures, ...linked.filter((path) => previewKindOf(path) != null), ...made];
  return [...new Set(candidates)].slice(0, MAX_OUTPUTS);
}
