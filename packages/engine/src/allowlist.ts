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
 * `bash(<命令>)`, the command a shell segment runs: the command word on its own
 * (`echo`, `rm`), or the command word plus its sub-command for the tools whose
 * sub-command is what really decides what happens (`git status`, `docker ps`).
 * A bare `bash` entry means「任何命令」: the UI no longer writes one, but an
 * older settings file may carry it and it still means what it said.
 */

/** Tool name for shell commands; the one tool whose entries are command-scoped. */
export const BASH_TOOL = "bash";

const BASH_ENTRY = /^bash\((.+)\)$/;

/** The allowlist entry that pre-approves one command. */
export const bashEntry = (command: string): string => `${BASH_TOOL}(${command})`;

/** The command an entry covers, or undefined when it is not a `bash(...)` entry. */
export function bashEntryCommand(entry: string): string | undefined {
  return BASH_ENTRY.exec(entry)?.[1];
}

/**
 * Command words whose *sub-command* is the thing that decides what happens, so
 * an entry has to name both: `bash(git status)` must not also mean `git push`.
 *
 * Membership is earned, not guessed. Each of these dispatches to sub-commands
 * that differ in kind — read vs. write, local vs. remote, install vs. run — and
 * each is common enough in a repository that a single blanket entry would be
 * written on the first task and regretted later:
 * - `git`, `gh`: `status` vs. `push`; `pr view` vs. `pr merge`.
 * - `docker`, `kubectl`: `ps`/`get` vs. `run`/`rm`/`delete`.
 * - `npm`, `pnpm`, `yarn`, `bun`, `cargo`, `go`, `pip`, `pip3`, `brew`: `test`
 *   or `list` vs. `install`, `publish`, `run`.
 * - `npx`, `bunx`: the first word *is* the package that runs, so a head-only
 *   entry would be a blank cheque for any package on the registry.
 * - `make`: the target names what the Makefile does — `build` vs. `deploy`.
 *
 * Two words is the whole rule; there is no three-word form. `docker compose up`
 * therefore becomes `bash(docker compose)`, which still keeps compose apart
 * from `docker run` and `docker rm` — the boundary that matters — while a
 * nested table would have to be grown and maintained per tool, and the same
 * argument would immediately reopen for `gh pr`, `cargo run` and the rest.
 * `pnpm run <script>` has the same shape and the same answer: the entry is
 * `bash(pnpm run)`.
 */
const COMPOSITE_HEADS = new Set([
  "git",
  "gh",
  "docker",
  "kubectl",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "cargo",
  "go",
  "pip",
  "pip3",
  "brew",
  "make",
]);

/**
 * The sub-command of a composite head has to be a bare word. A flag (`git -C x
 * status`) or anything else means we cannot say what this command does, so the
 * segment is not allowlistable at all — the same answer an unparseable command
 * has always got.
 */
const BARE_WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True for an entry that can no longer match anything: `bash(git)` and friends,
 * written before entries went down to the sub-command. Nothing is migrated —
 * widening `bash(git)` into every `git <sub>` would grant what the user never
 * granted — so the settings list marks these and lets them be removed.
 */
export function isVoidedBashEntry(entry: string): boolean {
  const command = bashEntryCommand(entry);
  return command != null && COMPOSITE_HEADS.has(command);
}

/**
 * Commands `bash` may run unattended in `allow-edits`, and which a `bash(...)`
 * entry never has to name. Deliberately tiny: it exists to stop the agent
 * stalling on `git status`, not to be a sandbox. Everything here must be
 * read-only *and* free of shell side effects — which rules out a test runner:
 * `pnpm test` runs whatever the agent has just written into the tests or the
 * `test` script, and this mode lets it write both. The first `pnpm test` asks;
 * 「一直允许」 then writes `bash(pnpm test)`, which is the user's own decision.
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
];

/** `find` predicates that execute, delete or write a file. Their presence disqualifies a `find`. */
const FIND_DANGEROUS_FLAGS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/**
 * Options that turn a read-only `git` command into one that writes a file
 * (`--output=<file>`) or runs a program the repository's config names
 * (`--ext-diff`, `--textconv`). Some git commands (and older versions of others)
 * accept any unambiguous prefix of a long option, so the check is on the prefix,
 * not on the full spelling — stricter than the newest `diff` and `log` need, and
 * free: none of these belongs in a read-only call.
 */
const GIT_DANGEROUS_OPTION = /^--(?:out|ext|textc)/;

/**
 * Options that make `rg` run another program: `--pre` (a preprocessor for every
 * file it searches), `--hostname-bin`, and `-z` / `--search-zip` (external
 * decompressors). Short flags can be bundled, and not only with letters: `-nz`,
 * but also `-0z` (`--null`) and `-.z` (`--hidden`). So any single-dash word with
 * a `z` in it counts; one where the `z` is really a value (`-ezip`, a pattern)
 * only costs a question.
 */
const RG_DANGEROUS_OPTION = /^(?:--(?:pre|hostname-bin|search-zip)|-(?!-).*z)/;

/** Whether a safe-listed command carries an option that makes it write or execute. */
function hasDangerousOption(words: readonly string[]): boolean {
  switch (words[0]) {
    case "find":
      return words.some((word) => FIND_DANGEROUS_FLAGS.has(word));
    case "git":
      // words[1] is the sub-command; only what follows it is an option.
      return words.slice(2).some((word) => GIT_DANGEROUS_OPTION.test(word));
    case "rg":
      return words.slice(1).some((word) => RG_DANGEROUS_OPTION.test(word));
    default:
      return false;
  }
}

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
  "su",
  "env",
  "xargs",
  "nohup",
  "time",
  "timeout",
  "gtimeout",
  "nice",
  "ionice",
  "stdbuf",
  "setsid",
  "watch",
  "caffeinate",
  "arch",
  "flock",
  "unshare",
  "nsenter",
  "chroot",
  "parallel",
  "busybox",
  "command",
  "builtin",
  "exec",
  "eval",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
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
 * The command one segment runs — what a `bash(...)` entry has to name — or
 * undefined when the segment cannot be read confidently: a subshell, a
 * substitution, a redirection, a quote, an `FOO=1` prefix, a wrapper that hides
 * the real command, or a composite head whose sub-command is not a bare word.
 */
export function segmentCommand(segment: string): string | undefined {
  const words = readableWords(segment);
  const head = words?.[0];
  if (head == null) return undefined;
  // `FOO=1 cmd`: the assignment changes what `cmd` does, and neither word is
  // honestly「the command」.
  if (head.includes("=")) return undefined;
  if (COMMAND_WRAPPERS.has(head)) return undefined;
  if (!COMPOSITE_HEADS.has(head)) return head;
  // `git` with no sub-command, `git -C x status`: nothing to name honestly, so
  // this segment always asks and is never offered as an entry.
  const sub = words?.[1];
  return sub != null && BARE_WORD.test(sub) ? `${head} ${sub}` : undefined;
}

/**
 * Every segment's command, in order and deduped — what 「一直允许」 would have to
 * write to cover this command line. Undefined when any segment is unparseable,
 * which is also why such a call gets no always-allow button at all.
 */
export function commandsToAllow(command: string): string[] | undefined {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  const commands: string[] = [];
  for (const segment of segments) {
    const runs = segmentCommand(segment);
    if (runs == null) return undefined;
    if (!commands.includes(runs)) commands.push(runs);
  }
  return commands;
}

function isSafeListedSegment(segment: string): boolean {
  const words = readableWords(segment);
  if (words == null) return false;

  const match = BASH_SAFE_LIST.find((prefix) => prefix.every((word, index) => words[index] === word));
  if (match === undefined) return false;

  // A bare `node` prefix is only allowed in the exact form on the list; extra
  // arguments (`--eval`, a script) would change what runs.
  if (match[0] === "node") return words.length === match.length;
  return !hasDangerousOption(words);
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
 * The commands in this command line the allowlist does not cover yet — what the
 * approval card offers to add, spelled exactly as the entry will be written
 * (`git push`). Empty means the call is already covered; undefined means the
 * command is unparseable and there is nothing honest to offer.
 */
export function unlistedCommands(command: string, allowlist: readonly string[]): string[] | undefined {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return undefined;
  const missing: string[] = [];
  for (const segment of segments) {
    if (isSafeListedSegment(segment)) continue;
    const runs = segmentCommand(segment);
    if (runs == null) return undefined;
    if (allowlist.includes(bashEntry(runs))) continue;
    if (!missing.includes(runs)) missing.push(runs);
  }
  return missing;
}

/**
 * Whether the global 「一直允许」 list already answers this tool call.
 *
 * For `bash` that is per *command*, not per tool: every segment has to run a
 * command the list names, or be on the built-in safe list. A legacy bare `bash`
 * entry covers everything, because that is what it promised when it was written;
 * a legacy `bash(git)` covers nothing, because `git` alone never was a promise
 * about `git push`.
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
  const missing = unlistedCommands(command, allowlist);
  return missing != null && missing.length === 0;
}
