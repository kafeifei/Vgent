/**
 * Permission mode → AI SDK `toolApproval` mapping.
 *
 * The engine ships one generic approval function (`GenericToolApprovalFunction`)
 * rather than a per-tool map, so the same policy covers MCP and subagent tools
 * once those are added: anything the policy does not recognise is treated as
 * side-effecting.
 */

/** How much the agent may do without asking. Mirrors the harness engines' modes. */
export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";

/** Subset of `ToolApprovalStatus` this module produces. */
export type ApprovalDecision = "not-applicable" | "user-approval";

/**
 * Tools that only observe the workspace. Never need approval in any mode.
 * `explore` is a read-only subagent (its child's tools are read-only too) and
 * `toolSearch` only looks up tool definitions — neither touches anything.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "explore", "toolSearch"]);

/**
 * Tools that only surface a question to the human and have no `execute` of
 * their own — asking has no side effects, so these never need approval
 * either. Kept separate from `READ_ONLY_TOOLS` because they don't observe the
 * workspace; they observe the user.
 */
const HUMAN_INPUT_TOOLS = new Set(["askUserQuestions"]);

/**
 * Tools that change files on disk. Approved outright from `allow-edits` up.
 * `coder` is the editing subagent: launching it is approved exactly like the
 * `write` it is going to perform, and inside it the same policy applies by
 * denial, since a subagent has no human to ask.
 */
const EDIT_TOOLS = new Set(["write", "edit", "coder"]);

/**
 * Commands `bash` may run unattended in `allow-edits`. Deliberately tiny: it
 * exists to stop the agent stalling on `git status`, not to be a sandbox.
 * Everything here must be read-only *and* free of shell side effects.
 */
const BASH_ALLOWLIST: readonly (readonly string[])[] = [
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
 * Splits a command line on the shell operators that start a new command
 * (`;`, `&&`, `||`, `|`, `&`). Every resulting segment has to be allowlisted on
 * its own, so `cat x; rm -rf /` cannot ride in on `cat`'s back.
 *
 * This is a lexical split, not a shell parse: quoting is not honoured, which
 * only ever makes the check stricter (a quoted `;` still splits, and the
 * resulting halves are unlikely to both be allowlisted).
 */
export function splitShellSegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|;|\||&)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isAllowlistedSegment(segment: string): boolean {
  if (UNSAFE_SHELL_CHARS.test(segment)) return false;
  // Quotes are rejected too: they hide operators from the lexical split above.
  if (segment.includes("'") || segment.includes('"')) return false;

  const words = segment.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return false;

  const match = BASH_ALLOWLIST.find((prefix) => prefix.every((word, index) => words[index] === word));
  if (match === undefined) return false;

  // A bare `node`/`pnpm`/`npm` prefix is only allowed in the exact allowlisted
  // form; extra arguments would change what runs.
  if (match[0] === "node" || match[0] === "pnpm" || match[0] === "npm") {
    return words.length === match.length;
  }
  if (words[0] === "find" && words.some((word) => FIND_DANGEROUS_FLAGS.has(word))) return false;
  return true;
}

/**
 * True when every segment of `command` is on the read-only allowlist. An empty
 * or unparseable command is not allowlisted.
 */
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isAllowlistedSegment);
}

/**
 * The permission decision for one tool call, with no AI SDK types involved so
 * it can be unit-tested directly.
 *
 * Unknown tool names fall through to `user-approval` in every mode but
 * `allow-all`: a tool the policy has not heard of is assumed to have effects.
 *
 * `alwaysAllow` is the task's own 「本任务内一直允许」 list: the user has already
 * approved these tools for this thread, so they short-circuit the mode.
 */
export function decideApproval({
  mode,
  toolName,
  input,
  alwaysAllow,
}: {
  mode: PermissionMode;
  toolName: string;
  input: unknown;
  alwaysAllow?: readonly string[];
}): ApprovalDecision {
  if (mode === "allow-all") return "not-applicable";
  if (alwaysAllow?.includes(toolName) === true) return "not-applicable";
  if (READ_ONLY_TOOLS.has(toolName) || HUMAN_INPUT_TOOLS.has(toolName)) return "not-applicable";

  if (EDIT_TOOLS.has(toolName)) {
    return mode === "allow-edits" ? "not-applicable" : "user-approval";
  }

  if (toolName === "bash") {
    if (mode !== "allow-edits") return "user-approval";
    const command = (input as { command?: unknown } | null | undefined)?.command;
    return typeof command === "string" && isReadOnlyCommand(command) ? "not-applicable" : "user-approval";
  }

  return "user-approval";
}

/**
 * Builds the generic `toolApproval` function for a permission mode, shaped for
 * `ToolLoopAgent`'s `toolApproval` option.
 */
export function createToolApproval(
  mode: PermissionMode,
  alwaysAllow?: readonly string[],
): (options: { toolCall: { toolName: string; input: unknown } }) => ApprovalDecision {
  return ({ toolCall }) =>
    decideApproval({
      mode,
      toolName: toolCall.toolName,
      input: toolCall.input,
      ...(alwaysAllow != null ? { alwaysAllow } : {}),
    });
}
