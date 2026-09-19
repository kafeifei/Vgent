/** The composer's `/命令` token: where one is being typed, what it matches, and how it leaves. */

export interface Slash {
  /** Offset of the `/` itself. */
  start: number;
  /** Offset just past the query — the caret, while the menu is live. */
  end: number;
  /** What was typed after the `/`; empty right after it. */
  query: string;
}

/** One row of the `/` menu. */
export interface SlashCommand {
  /** What is typed after the `/`, e.g. `plan`. */
  id: string;
  /** Other spellings that find the same row (`summarize` for `compact`). */
  aliases?: readonly string[];
  label: string;
  hint: string;
  /** The small grey heading the row is listed under. */
  section: string;
  /** A row that is shown but cannot be run right now, and why. */
  disabledReason?: string | undefined;
  /** Marks the row that is already in force (the current mode). */
  selected?: boolean;
  run: () => void;
}

/**
 * The `/…` the caret sits at the end of, or `null`.
 *
 * Same rule as Cursor's: a command only starts at the beginning of a line or
 * after whitespace or `(`, so a path like `src/app` never opens the menu.
 */
export function findSlash(text: string, caret: number): Slash | null {
  const match = /(^|[\s(])\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (match == null) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}

/** Rows whose id, an alias or the label starts with — then merely contains — the query. */
export function matchSlash(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...commands];
  const keys = (command: SlashCommand): string[] =>
    [command.id, ...(command.aliases ?? []), command.label].map((key) => key.toLowerCase());
  const starts = commands.filter((command) => keys(command).some((key) => key.startsWith(needle)));
  const contains = commands.filter(
    (command) => !starts.includes(command) && keys(command).some((key) => key.includes(needle)),
  );
  return [...starts, ...contains];
}

/** The text with the `/query` cut out, and where the caret lands. */
export function removeSlash(text: string, slash: Slash): { text: string; caret: number } {
  return { text: text.slice(0, slash.start) + text.slice(slash.end), caret: slash.start };
}
