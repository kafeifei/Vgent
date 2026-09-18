/**
 * Permission mode → AI SDK `toolApproval` mapping.
 *
 * The engine ships one generic approval function (`GenericToolApprovalFunction`)
 * rather than a per-tool map, so the same policy covers MCP and subagent tools
 * once those are added: anything the policy does not recognise is treated as
 * side-effecting.
 */

import { BASH_TOOL, isAllowlisted, isReadOnlyCommand } from "./allowlist.js";

/** How much the agent may do without asking. Mirrors the harness engines' modes. */
export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";

/** Subset of `ToolApprovalStatus` this module produces. */
export type ApprovalDecision = "not-applicable" | "user-approval";

/**
 * Tools that only observe the workspace. Never need approval in any mode.
 * `explore` is a read-only subagent (its child's tools are read-only too) and
 * `toolSearch` only looks up tool definitions — neither touches anything.
 * `updatePlan` has no side effects either: it only replaces the todo list the
 * UI renders, never anything on disk or for the user.
 * `memory` does write, but only inside its own directory outside the repository
 * — never the user's code — so asking for each note would be pure friction.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "explore", "toolSearch", "updatePlan", "memory"]);

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
 * The permission decision for one tool call, with no AI SDK types involved so
 * it can be unit-tested directly.
 *
 * Unknown tool names fall through to `user-approval` in every mode but
 * `allow-all`: a tool the policy has not heard of is assumed to have effects.
 *
 * `alwaysAllow` is the global 「一直允许」 list. For `bash` it is command-scoped
 * (`bash(git)`), so whether it answers this call depends on the command — see
 * `isAllowlisted`, which the browser runs on the very same entries.
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
  if (isAllowlisted({ toolName, input, allowlist: alwaysAllow })) return "not-applicable";
  if (READ_ONLY_TOOLS.has(toolName) || HUMAN_INPUT_TOOLS.has(toolName)) return "not-applicable";

  if (EDIT_TOOLS.has(toolName)) {
    return mode === "allow-edits" ? "not-applicable" : "user-approval";
  }

  if (toolName === BASH_TOOL) {
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
