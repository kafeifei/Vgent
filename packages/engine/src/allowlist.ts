/**
 * 「一直允许」: what the global allowlist can say, and whether one tool call is
 * covered by it.
 *
 * Deliberately dependency-free — no imports at all — because the browser
 * imports this very file through `@vgent/engine/allowlist` to answer the same
 * question client-side for the harness engines. Keep it that way: anything that
 * pulls in `ai`, zod or a node builtin belongs in another module.
 *
 * An entry is either a plain tool name (`write`, `edit`, an MCP tool's name) or
 * `bash(<head>)`, the command word of a shell segment (`git`, `pnpm`, `echo`).
 * A bare `bash` entry means「任何命令」: the UI no longer writes one, but an
 * older settings file may carry it and it still means what it said.
 */

/** Tool name for shell commands; the one tool whose entries are command-scoped. */
export const BASH_TOOL = "bash";

const BASH_ENTRY = /^bash\((.+)\)$/;

/** The allowlist entry that pre-approves one command head. */
export const bashEntry = (head: string): string => `${BASH_TOOL}(${head})`;

/** The head an entry covers, or undefined when it is not a `bash(...)` entry. */
export function bashEntryHead(entry: string): string | undefined {
  return BASH_ENTRY.exec(entry)?.[1];
}

/**
 * Commands `bash` may run unattended in `allow-edits`, and which a `bash(...)`
 * entry never has to name. Deliberately tiny: it exists to stop the agent
 * stalling on `git status`, not to be a sandbox. Everything here must be
 * read-only *and* free of shell side effects.
 */
const BASH_SAFE_LIST: readonly (readonly string[])[] = [
  ["ls"],
  ["cat"],
  ["pwd"],
  ["rg"],
  ["grep"],
  ["find"],
  ["git", "status"],
  ["git", "diff"],
  ["git", "log"],
  ["node", "--version"],
  ["pnpm", "test"],
  ["npm", "test"],
];

/** `find` predicates that execute or delete. Their presence disqualifies a `find`. */
const FIND_DANGEROUS_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf"]);

/** Characters that chain, redirect or substitute — a segment containing one is never auto-approved. */
const UNSAFE_SHELL_CHARS = /[<>$`(){}\\!*?~#\n\r]/;

/**
 * First words that decide what really runs instead of being the thing that
 * runs. `sudo rm` must not be pre-approved by an entry naming `rm`, and
 * 「一直允许 sudo」 would be a blank cheque — so a segment starting with one of
 * these has no head at all.
 */
const COMMAND_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "xargs",
  "nohup",
  "time",
  "command",
  "exec",
  "eval",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

/**
 * Splits a command line on the shell operators that start a new command
 * (`;`, `&&`, `||`, `|`, `&`). Every resulting segment has to be covered on its
 * own, so `cat x; rm -rf /` cannot ride in on `cat`'s back.
 *
 * This is a lexical split, not a shell parse: quoting is not honoured, which
 * only ever makes the check stricter (a quoted `;` still splits, and the
 * resulting halves are unlikely to both be covered).
 */
export function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|;|\||&)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The words of a segment we are willing to reason about, or undefined. */
function readableWords(segment: string): string[] | undefined {
  if (UNSAFE_SHELL_CHARS.test(segment)) return undefined;
  // Quotes are rejected too: they hide operators from the lexical split above.
  if (segment.includes("'") || segment.includes('"')) return undefined;
  const words = segment.split(/\s+/).filter((word) => word.length > 0);
  return words.length === 0 ? undefined : words;
}

/**
 * The command word of one segment — what a `bash(...)` entry names — or
 * undefined when the segment cannot be read confidently: a subshell, a
 * substitution, a redirection, a quote, an `FOO=1` prefix, or a wrapper that
 * hides the real command.
 */
export function segmentHead(segment: string): string | undefined {
  const words = readableWords(segment);
  const head = words?.[0];
  if (head == null) return undefined;
  // `FOO=1 cmd`: the assignment changes what `cmd` does, and neither word is
  // honestly「the command」.
  if (head.includes("=")) return undefined;
  if (COMMAND_WRAPPERS.has(head)) return undefined;
  return head;
}

/**
 * Every segment's head, in order and deduped — what 「一直允许」 would have to
 * write to cover this command. Undefined when any segment is unparseable, which
 * is also why such a call gets no always-allow button at all.
 */
export function commandHeads(command: string): string[] | undefined {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  const heads: string[] = [];
  for (const segment of segments) {
    const head = segmentHead(segment);
    if (head == null) return undefined;
    if (!heads.includes(head)) heads.push(head);
  }
  return heads;
}

function isSafeListedSegment(segment: string): boolean {
  const words = readableWords(segment);
  if (words == null) return false;

  const match = BASH_SAFE_LIST.find((prefix) => prefix.every((word, index) => words[index] === word));
  if (match === undefined) return false;

  // A bare `node`/`pnpm`/`npm` prefix is only allowed in the exact form on the
  // list; extra arguments would change what runs.
  if (match[0] === "node" || match[0] === "pnpm" || match[0] === "npm") {
    return words.length === match.length;
  }
  if (words[0] === "find" && words.some((word) => FIND_DANGEROUS_FLAGS.has(word))) return false;
  return true;
}

/**
 * True when every segment of `command` is on the built-in safe list. An empty
 * or unparseable command is not.
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isSafeListedSegment);
}

/**
 * The heads of this command the allowlist does not cover yet — what the
 * approval card offers to add. Empty means the call is already covered;
 * undefined means the command is unparseable and there is nothing honest to
 * offer.
 */
export function unlistedHeads(command: string, allowlist: readonly string[]): string[] | undefined {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  const missing: string[] = [];
  for (const segment of segments) {
    if (isSafeListedSegment(segment)) continue;
    const head = segmentHead(segment);
    if (head == null) return undefined;
    if (allowlist.includes(bashEntry(head))) continue;
    if (!missing.includes(head)) missing.push(head);
  }
  return missing;
}

/**
 * Whether the global 「一直允许」 list already answers this tool call.
 *
 * For `bash` that is per *command*, not per tool: every segment has to have a
 * head the list names, or be on the built-in safe list. A legacy bare `bash`
 * entry covers everything, because that is what it promised when it was written.
 */
export function isAllowlisted({
  toolName,
  input,
  allowlist,
}: {
  toolName: string;
  input: unknown;
  allowlist: readonly string[] | undefined;
}): boolean {
  if (allowlist == null || allowlist.length === 0) return false;
  if (toolName !== BASH_TOOL) return allowlist.includes(toolName);
  if (allowlist.includes(BASH_TOOL)) return true;
  const command = (input as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return false;
  const missing = unlistedHeads(command, allowlist);
  return missing != null && missing.length === 0;
}
