/**
 * A small, dependency-free unified-diff renderer for the `edit` tool.
 *
 * Unlike a general-purpose diff (e.g. `git diff --no-index`, which freecode
 * uses), the `edit` tool already knows exactly which byte ranges of the file
 * changed — every occurrence of `old_string` it just replaced. So instead of
 * diffing two full files, this renders one unified-diff hunk per occurrence
 * directly from that knowledge, with a few lines of context around each.
 */
export interface EditOccurrence {
  /** Character offset of the occurrence in the original content. */
  start: number;
}

export interface BuildEditDiffOptions {
  /** Lines of unchanged context to show around each hunk. Defaults to 3. */
  contextLines?: number;
  /** Hard cap on the number of lines in the rendered snippet. Defaults to 40. */
  maxLines?: number;
}

function lineIndexAt(text: string, charIndex: number): number {
  let searchFrom = 0;
  let line = 0;
  for (;;) {
    const next = text.indexOf("\n", searchFrom);
    if (next === -1 || next >= charIndex) return line;
    searchFrom = next + 1;
    line++;
  }
}

/**
 * Renders a unified-diff snippet for replacing `oldString` with `newString`
 * at each occurrence's start offset in `before` (the original file content).
 * Occurrences must be in ascending order by `start`, as produced by a
 * left-to-right scan of `before`.
 */
export function buildEditDiff(
  path: string,
  before: string,
  oldString: string,
  newString: string,
  occurrences: readonly EditOccurrence[],
  options: BuildEditDiffOptions = {},
): { diff: string; truncated: boolean } {
  const contextLines = options.contextLines ?? 3;
  const maxLines = options.maxLines ?? 40;
  const beforeLines = before.split("\n");
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const hunks: string[][] = occurrences.map((occurrence) => {
    const startLineIdx = lineIndexAt(before, occurrence.start);
    const endLineIdx = startLineIdx + oldLines.length - 1;
    const contextStart = Math.max(0, startLineIdx - contextLines);
    const contextEnd = Math.min(beforeLines.length - 1, endLineIdx + contextLines);

    const oldCount = contextEnd - contextStart + 1;
    const newCount = oldCount - oldLines.length + newLines.length;
    const lines: string[] = [`@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`];
    for (let i = contextStart; i < startLineIdx; i++) lines.push(` ${beforeLines[i]}`);
    for (const line of oldLines) lines.push(`-${line}`);
    for (const line of newLines) lines.push(`+${line}`);
    for (let i = endLineIdx + 1; i <= contextEnd; i++) lines.push(` ${beforeLines[i]}`);
    return lines;
  });

  const body = [`--- a/${path}`, `+++ b/${path}`, ...hunks.flat()];
  if (body.length <= maxLines) return { diff: body.join("\n"), truncated: false };

  const shown = body.slice(0, Math.max(0, maxLines - 1));
  shown.push(`... (diff truncated, ${body.length - shown.length} more lines)`);
  return { diff: shown.join("\n"), truncated: true };
}
