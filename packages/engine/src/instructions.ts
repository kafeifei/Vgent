import type { ToolSet } from "ai";
import type { SkillSummary } from "./skills.js";

/** Host-supplied identity and workspace facts; tool capabilities live on the tools. */
export interface VgentContext {
  modelId?: string;
  host?: string;
  workspaceKind?: "project" | "scratch";
  workspace?: {
    branch: string;
    baseCommit: string;
  };
}

export interface BuildInstructionsOptions {
  repoPath: string;
  projectPath?: string;
  context?: VgentContext;
  /** The selected tool set, after mode filtering. Tool descriptions are sent by the SDK. */
  tools: ToolSet;
  /** Produced by the same policy instance used for tool execution. */
  approvalInstructions: string;
  extra?: string;
  /** Delegated role and reporting requirements, when building a child's context. */
  role?: string;
  plan?: boolean;
  skills?: readonly SkillSummary[];
}

/** Shared plan-document requirements for engines supporting Plan mode. */
export function planModeInstructions({ askTool }: { askTool: boolean }): string {
  return `Plan mode. This turn is read-only: you have no tool that writes files or runs shell commands, and
any attempt to change the repository will fail. Do not promise to make an edit in this turn.
- Research first. Read and search until you can name the real files and the real call sites; never plan
  against code you have not opened.
- When the goal is genuinely ambiguous, ask instead of guessing. ${
    askTool
      ? "Use `askUserQuestions`; it is the one tool here that stops and waits for the human."
      : "Ask in plain text and stop; the user answers in their next message."
  }
- Finish with the plan itself, as Markdown, in the user's language: the goal, the approach, the files to
  touch, the steps in order, and how to verify it. Nothing after it — no closing summary, no offer to
  proceed.
- That final reply is saved verbatim as this task's plan document. The user edits it before pressing
  Build, so write a document they can edit, not a message addressed to them.`;
}

function identityLine(context: VgentContext | undefined): string {
  const { modelId, host } = context ?? {};
  const where = host == null ? "the Vgent workbench" : `the Vgent workbench (host: ${host})`;
  return `You are a coding assistant running inside ${where}.${modelId == null ? "" : ` Your model identifier is ${JSON.stringify(modelId)}; use that identifier when asked.`}`;
}

function workspaceLine(context: VgentContext | undefined, projectPath: string | undefined): string {
  const workspace = context?.workspace;
  if (workspace) {
    return `This directory is a dedicated git worktree ${projectPath ? `of the project at ${JSON.stringify(projectPath)}, ` : ""}on branch ${JSON.stringify(workspace.branch)}, created from commit ${JSON.stringify(workspace.baseCommit)}. Check git log / git worktree list / git branch -a when you need to establish the current checkout state.`;
  }
  if (context?.workspaceKind === "scratch") return "This is a scratch workspace with no attached project.";
  if (context?.workspaceKind === "project") return "This is the project's own working directory.";
  return "No project or worktree metadata was supplied; inspect the directory before assuming its repository or branch.";
}

/** General behavior and current context only. Tool-specific guidance belongs to tool definitions. */
export function buildInstructions(options: BuildInstructionsOptions): string {
  const { repoPath, projectPath, context, tools, approvalInstructions, extra, role, plan, skills } = options;
  const visible = Object.entries(tools).filter(([, definition]) => !definition.deferLoading).map(([name]) => name);
  return [
    identityLine(context),
    role,
    `Working directory: ${repoPath}\n${workspaceLine(context, projectPath)}`,
    `Available tools: ${visible.length ? visible.join(", ") : "none"}. Consult each tool's description for its usage and actual access boundaries.`,
    approvalInstructions,
    `How to work:
- Read the relevant code before changing it. Match the surrounding conventions and verify with the narrowest relevant check.
- Follow authorization already given in this conversation and applicable project instructions. Complete the necessary steps of authorized work without asking for the same authorization again. Tool approval still applies.
- Preserve unrelated changes. Keep destructive actions, publication and app/process lifecycle operations within the user's authorization.
- Investigate discrepancies between the user's statements and the workspace before asking the user to explain them.
- Prefer executing the task over narrating a plan. Ask only for missing information or decisions that require the user's input.
- A status question or correction supplements the current task; replace the objective only when the user cancels or replaces it.
- Before finishing, check remaining work and authorized delivery obligations. Tool success alone is not task completion.
- Report verified results and specific blockers. After interruption, verify uncertain side effects before repeating them. An existing artifact does not prove a repeated request ran.`,
    plan ? planModeInstructions({ askTool: tools.askUserQuestions != null }) : undefined,
    tools.read && skills?.length
      ? `Available skills — instructions for specific kinds of work. Read the skill's SKILL.md before relying on it, and only when the task matches it.\n${skills.map((skill) => `- ${skill.name}: ${skill.description}（${skill.path}）`).join("\n")}`
      : undefined,
    role ? undefined : "When you are done, reply with a short summary of the verified result, relevant files and any remaining work.",
    extra?.trim(),
  ].filter(Boolean).join("\n\n");
}
