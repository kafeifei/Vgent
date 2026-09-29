/**
 * Permission mode → AI SDK `toolApproval` mapping.
 *
 * The engine ships one generic approval function (`GenericToolApprovalFunction`)
 * rather than a per-tool map, so the same policy covers MCP and subagent tools
 * once those are added: anything the policy does not recognise is treated as
 * side-effecting.
 */

import { BASH_TOOL, bashEntryCommand, isVoidedBashEntry, isAllowlisted, isReadOnlyCommand } from "./allowlist.js";

/** How much the agent may do without asking. Mirrors the harness engines' modes. */
export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";

/** Subset of `ToolApprovalStatus` this module produces. */
export type ApprovalDecision = "not-applicable" | "user-approval";

/**
 * Tools that only observe the workspace. Never need approval in any mode.
 * `explore` is a read-only subagent (its child's tools are read-only too) and
 * `toolSearch` only looks up tool definitions — neither touches anything.
 * `updatePlan` persists task state, and is approved as internal bookkeeping.
 * `memory` does write, but only inside its own directory outside the repository
 * — never the user's code — so asking for each note would be pure friction.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "explore", "toolSearch", "tool_search", "updatePlan", "memory"]);
const CUA_READ_ONLY_TOOLS = new Set([
  "cua__list_apps", "cua__list_windows", "cua__get_window_state", "cua__get_accessibility_tree",
  "cua__get_desktop_state", "cua__get_screen_size", "cua__get_cursor_position",
  "cua__get_browser_state", "cua__verify_state", "cua__zoom",
]);

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
 * (`bash(git status)`), so whether it answers this call depends on the command — see
 * `isAllowlisted`, which the browser runs on the very same entries.
 */
interface ApprovalOptions {
  mode: PermissionMode;
  alwaysAllow?: readonly string[];
}

/** Both the decision and its explanation use this classification. */
function requirement(options: ApprovalOptions, toolName: string): "immediate" | "command" | "approval" {
  const { mode, alwaysAllow } = options;
  if (mode === "allow-all" || isAllowlisted({ toolName, input: undefined, allowlist: alwaysAllow })) return "immediate";
  if (READ_ONLY_TOOLS.has(toolName) || CUA_READ_ONLY_TOOLS.has(toolName) || HUMAN_INPUT_TOOLS.has(toolName)) return "immediate";
  if (EDIT_TOOLS.has(toolName) && mode === "allow-edits") return "immediate";
  // isAllowlisted also accepts built-in command rules when a standing list is present.
  if (toolName === BASH_TOOL && (mode === "allow-edits" || (alwaysAllow?.length ?? 0) > 0)) return "command";
  return "approval";
}

export function decideApproval(options: ApprovalOptions & { toolName: string; input: unknown }): ApprovalDecision {
  const { toolName, input, mode, alwaysAllow } = options;
  const kind = requirement(options, toolName);
  if (kind === "immediate") return "not-applicable";
  if (kind === "command") {
    if (isAllowlisted({ toolName, input, allowlist: alwaysAllow })) return "not-applicable";
    const command = (input as { command?: unknown } | null | undefined)?.command;
    if (mode === "allow-edits" && typeof command === "string" && isReadOnlyCommand(command)) return "not-applicable";
  }
  return "user-approval";
}

/** One turn's effective policy, shared by execution and model-facing instructions. */
export function createApprovalPolicy(mode: PermissionMode, alwaysAllow: readonly string[] = []) {
  const options: ApprovalOptions = { mode, alwaysAllow: [...alwaysAllow] };
  return {
    toolApproval: ({ toolCall }: { toolCall: { toolName: string; input: unknown } }) => decideApproval({ ...options, ...toolCall }),
    describe(toolNames: readonly string[], interactive: boolean): string {
      const groups = {
        immediate: toolNames.filter((name) => requirement(options, name) === "immediate"),
        command: toolNames.filter((name) => requirement(options, name) === "command"),
        approval: toolNames.filter((name) => requirement(options, name) === "approval"),
      };
      const standing = options.alwaysAllow!.filter((entry) =>
        !isVoidedBashEntry(entry) && (toolNames.includes(entry) || (toolNames.includes(BASH_TOOL) && bashEntryCommand(entry) != null)),
      );
      const pending = interactive ? "require tool approval" : "are denied in this subagent; report the blocked operation to the parent";
      return [
        `Permission mode: ${mode}.`,
        groups.immediate.length ? `Run without tool approval: ${groups.immediate.join(", ")}.` : "",
        groups.command.length ? `Command-dependent approval: ${groups.command.join(", ")}. The engine checks the full input against its built-in command rules and standing approvals; unmatched calls ${pending}. These checks do not provide OS isolation.` : "",
        groups.approval.length ? `Calls to ${groups.approval.join(", ")} ${pending}.` : "",
        standing.length ? `Applicable standing approvals: ${JSON.stringify(standing)}. Shell entries are command-scoped and every segment must pass the engine's checks.` : "",
        toolNames.some((name) => name === "toolSearch" || name === "tool_search") ? `Tools discovered later use the same policy; unrecognized tools ${mode === "allow-all" ? "run without tool approval" : pending}.` : "",
        interactive
          ? "Submit an authorized tool call to let the approval system handle it. Do not ask a separate conversational permission question. Respect a denial; do not route the same operation through another tool to bypass it."
          : "This subagent cannot ask the user for approval. A denied call is a limitation to report, not permission to bypass the policy.",
        "Tool approval does not expand the user's task scope or the tool's actual capabilities.",
      ].filter(Boolean).join("\n");
    },
  };
}
