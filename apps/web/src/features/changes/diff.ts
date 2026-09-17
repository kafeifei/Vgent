/** The kinds of line the pane renders. Header lines are dropped while parsing. */
export type DiffLineKind = "hunk" | "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffLineKind;
  /** The raw line, marker included — the gutter carries the number. */
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** `@@ -a,b +c,d @@` — the counts are noise, only the two starts matter. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Raw `git diff` text → the lines the pane draws, with running line numbers.
 *
 * Everything outside a hunk (`diff --git`, `index`, `---`, `+++`, the mode and
 * rename lines) is header noise and never reaches the caller — which is also
 * why `---` / `+++` cannot be mistaken for a del / add line.
 */
export function parseUnifiedDiff(text: string): DiffLine[] {
  if (text === "") return [];

  const raws = text.split("\n");
  // The trailing newline of a diff leaves one empty tail line behind.
  if (raws.at(-1) === "") raws.pop();

  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of raws) {
    const hunk = HUNK.exec(raw);
    if (hunk != null) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    // A second `diff --git` starts the next file's header.
    if (raw.startsWith("diff --git ")) inHunk = false;
    if (!inHunk) continue;

    if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw, newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw, oldNo: oldNo++ });
    } else {
      lines.push({ kind: "ctx", text: raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }

  return lines;
}
