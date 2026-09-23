import { localPathOf, previewKindOf } from "@/lib/preview";
import { describeTool } from "./toolMeta";
import type { Block } from "./turns";

/** More cards than this under one reply is a directory listing, not a result. */
const MAX_OUTPUTS = 12;

const LINK = /!?\[[^\]]*\]\(\s*<?([^)>\s]+(?: [^)>\s]+)*)>?(?:\s+"[^"]*")?\s*\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const FENCE = /```[\s\S]*?(?:```|$)/g;

/** The files a reply points at with a link, and the ones it only mentions in `inline code`. */
function namedIn(text: string): { linked: string[]; mentioned: string[]; shownPictures: string[] } {
  const prose = text.replace(FENCE, "");
  const linked: string[] = [];
  const mentioned: string[] = [];
  const shownPictures: string[] = [];
  for (const match of prose.matchAll(LINK)) {
    const path = localPathOf(match[1] ?? "");
    if (path == null) continue;
    // A markdown image is already on screen where the reply put it.
    if (match[0].startsWith("!")) {
      if (previewKindOf(path) === "image" || previewKindOf(path) === "svg") shownPictures.push(path);
    } else linked.push(path);
  }
  for (const match of prose.matchAll(INLINE_CODE)) {
    const span = (match[1] ?? "").trim();
    if (!/\s/.test(span) && previewKindOf(span) != null) mentioned.push(span);
  }
  return { linked, mentioned, shownPictures };
}

/** Local pictures the reply already rendered inline, in that turn alone. */
export function shownPicturePaths(blocks: readonly Block[]): string[] {
  return [...new Set(blocks.flatMap((block) => block.kind === "text" ? namedIn(block.part.text).shownPictures : []))];
}

/** Compare resolved task paths, since tools may write an absolute path while the reply uses a relative one. */
export function visibleOutputFiles(files: readonly { raw: string; path: string }[], shown: readonly string[]): { raw: string; path: string }[] {
  const names = new Set(shown);
  const alreadyShown = new Set(files.filter((file) => names.has(file.raw)).map((file) => file.path));
  return files.filter((file) => !alreadyShown.has(file.path));
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

const field = (input: Record<string, unknown>, name: string): string | undefined => (typeof input[name] === "string" ? (input[name] as string) : undefined);

/** One `edit` applied to text the way the tool applied it; `undefined` when it does not fit, i.e. we lost track of the file. */
function applyEdit(text: string, edit: Record<string, unknown>): string | undefined {
  const from = field(edit, "old_string");
  const to = field(edit, "new_string");
  if (from == null || to == null || !text.includes(from)) return undefined;
  return edit.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
}

/**
 * What the turn left in each SVG it wrote, replayed from its own calls: the
 * `write` carries the whole file and every `edit` after it a replacement. A
 * task told 「再来一次」 writes the same path again, and the file on disk only
 * remembers the last one — this is how an earlier turn still shows its own
 * drawing. `before` is what earlier turns left, so a turn that only points at
 * the file shows it as it was then. Keyed by the path as the call gave it. A file we lose track of (an
 * edit that does not fit, an engine whose calls carry no content) is left out,
 * and is shown from disk as before.
 */
export function writtenDrawings(blocks: readonly Block[], before?: ReadonlyMap<string, string>): Map<string, string> {
  const drawings = new Map<string, string>(before);
  for (const block of blocks) {
    if (block.kind !== "tool" || block.part.state !== "output-available") continue;
    const display = describeTool(block.part);
    const file = display.file;
    if (file == null || previewKindOf(file) !== "svg") continue;
    const input = (typeof block.part.input === "object" && block.part.input !== null ? block.part.input : {}) as Record<string, unknown>;
    if (display.kind === "write") {
      const content = field(input, "content");
      if (content != null) drawings.set(file, content);
      else drawings.delete(file);
    } else if (display.kind === "edit") {
      const before = drawings.get(file);
      if (before == null) continue;
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [input];
      let after: string | undefined = before;
      for (const edit of edits) after = after == null ? undefined : applyEdit(after, edit);
      if (after == null) drawings.delete(file);
      else drawings.set(file, after);
    }
  }
  return drawings;
}

/** The drawing held for a file the server resolved: calls spell a path absolutely or relative to the task, the server the latter. */
export function drawingFor(drawings: ReadonlyMap<string, string>, file: { raw: string; path: string }): string | undefined {
  for (const [written, svg] of drawings) {
    if (written === file.raw || written === file.path || written.endsWith(`/${file.path}`)) return svg;
  }
  return undefined;
}
