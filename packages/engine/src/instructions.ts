import type { PermissionMode } from "./permissions.js";
import type { SkillSummary } from "./skills.js";

const PERMISSION_DESCRIPTIONS: Record<PermissionMode, string> = {
  "allow-reads":
    "allow-reads — reading, searching and globbing run immediately; every file write, file edit and shell command needs the user's approval first.",
  "allow-edits":
    "allow-edits — reading, searching, globbing, writing and editing files run immediately; shell commands need the user's approval unless they are plainly read-only (ls, cat, pwd, rg, grep, find, git status/diff/log).",
  "allow-all": "allow-all — every tool runs immediately without approval. Be correspondingly careful.",
};

/**
 * Who and where the agent is. Everything here is knowledge the process has and
 * the model cannot derive: which model string the host picked for it, which
 * front end it is answering through, and whether the working directory is the
 * project itself or a worktree cut from it. Without it the model guesses —
 * real transcripts had it claim to be someone else's model and ask the user
 * where the rest of the code lives instead of running `git worktree list`.
 */
export interface VgentContext {
  /** The model string the host resolved, verbatim — what "which model are you" should answer. */
  modelId?: string;
  /** The front end this run is answering through, in prose, e.g. `Vgent desktop app (macOS)`. */
  host?: string;
  /** Present only when the working directory is a git worktree cut from the project. */
  workspace?: {
    /** The worktree itself — the same directory as `repoPath`. */
    path: string;
    /** The project's own checkout, which this worktree's edits never touch. */
    projectPath: string;
    branch: string;
    baseCommit: string;
  };
}

export interface BuildInstructionsOptions {
  /** Absolute path the tools are confined to. */
  repoPath: string;
  /** Who and where the agent is. Omitted, the prompt falls back to the generic opening. */
  context?: VgentContext;
  /** The mode whose rules are spelled out to the model. */
  permissionMode: PermissionMode;
  /** Caller-supplied guidance, appended verbatim after the built-in prompt. */
  extra?: string;
  /** Whether the `explore` / `coder` subagent tools are in the tool set. */
  subagents?: boolean;
  /** A 计划 turn: read-only research that ends in the plan document. Adds {@link planModeInstructions}. */
  plan?: boolean;
  /** Whether deferred tools (MCP servers) are reachable through `toolSearch`. */
  toolSearch?: boolean;
  /** Names and descriptions of the skills on this machine. Bodies are never inlined. */
  skills?: readonly SkillSummary[];
  /** Where the `memory` tool stores its entries, and which ones already exist. Omitted, the tool is not offered. */
  memory?: { dir: string; entries: readonly string[] };
}

const SUBAGENTS_SECTION = `Subagents:
- \`explore\` runs a read-only research task in its own context and returns a summary. Use it when answering
  would mean reading or searching many files: it keeps that cost out of this conversation. Say what you
  already know so it does not repeat your work.
- \`coder\` carries out one already-decided, mechanical change and returns a report. Decide the design
  yourself first and hand it everything it needs — it cannot see this conversation and will stop and ask
  rather than choose.
- Both return only a summary, not their transcript. If you need a detail they did not report, ask again or
  look yourself. Neither can ask the user anything; a step that would need approval fails inside them.`;

/**
 * The Plan-mode addendum, shared by every engine that can run a 计划 turn — the
 * in-house one through {@link buildInstructions}, Claude Code through the
 * harness agent's own `instructions`. One text, so the two cannot drift.
 *
 * `askTool` is the only difference between them: the in-house engine can ask
 * with `askUserQuestions`, a harness engine has to ask in prose and stop.
 */
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

const TOOL_SEARCH_SECTION = `Extra tools:
- More tools than the ones described here are available but hidden. Call \`toolSearch\` with a few keywords
  to find them by name and description; what it finds becomes callable on your next step.`;

function skillsSection(skills: readonly SkillSummary[]): string {
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}（${skill.path}）`);
  return `Available skills — instructions for specific kinds of work. This is only the index; \`read\` a
skill's SKILL.md before relying on it, and only when the task actually matches it.
${lines.join("\n")}`;
}

function memorySection(memory: { dir: string; entries: readonly string[] }): string {
  return `跨任务记忆 —— \`memory\` 工具，条目存在 ${memory.dir}：
- 现有条目：${memory.entries.length === 0 ? "暂无" : memory.entries.join(", ")}
- 动手之前，先 \`read\` 名字看起来和本次任务相关的条目；不相关的不用读。
- 用户让你记住某件事，或代码和 git 中查不到的事实对未来有用时，\`write\` 一条。
- 用户约定用 user-instruction，引用来源消息 ID 和原话；不扩大或改写限制。模型推断用 inference，不能作为授权或硬约束。
- 当前明确纠正优先于旧记忆。纠正时更新受影响的条目，不留下相互矛盾的约定。`;
}

/** The opening sentence: what the model is and what it is running inside. */
function identityLine(context: VgentContext | undefined): string {
  const { modelId, host } = context ?? {};
  if (modelId == null && host == null) return "You are Vgent, a coding agent working directly in a user's repository.";
  const where = host == null ? "the Vgent workbench" : `the Vgent workbench (host: ${host})`;
  if (modelId == null) return `You are Vgent, a coding agent running inside ${where}.`;
  // One line per sentence: the interpolations vary in length, so hard-wrapping
  // the source would put the breaks in arbitrary places in the actual prompt.
  return `You are Vgent, a coding agent running inside ${where} as the model \`${modelId}\`. When asked what model you are, answer with that identifier.`;
}

/** What the working directory *is* — the project, or a worktree cut from it. */
function workspaceLine(workspace: VgentContext["workspace"]): string {
  if (workspace == null) return "This is the project's main working tree.";
  return `This directory is a dedicated git worktree of the project at \`${workspace.projectPath}\`, on branch \`${workspace.branch}\`, created from commit \`${workspace.baseCommit}\`. Edits here never touch the project's main working tree. The code you can read is whatever that commit contains — if the user talks about code you cannot find, check \`git log\` / \`git worktree list\` / \`git branch -a\` in the project before concluding it does not exist.`;
}

/**
 * The engine's system prompt. Kept deliberately short: rules the model can
 * actually follow beat an exhaustive policy it will skim.
 */
export function buildInstructions({
  repoPath,
  context,
  permissionMode,
  extra,
  subagents,
  plan,
  toolSearch,
  skills,
  memory,
}: BuildInstructionsOptions): string {
  const head = `${identityLine(context)}

Working directory: ${repoPath}
File tools resolve paths relative to it. Additional configured project roots are available for authorized delivery; read-only skill roots do not grant write access. Shell commands run on the host and remain subject to tool approval and the user's scope.
${workspaceLine(context?.workspace)}

Permission mode: ${PERMISSION_DESCRIPTIONS[permissionMode]}

How to work:
- Understand before you change. Read the relevant files and search the surrounding code first.
- Always \`read\` a file before you \`write\` or \`edit\` it, in this same session. Never edit from memory.
- \`edit\` replaces an exact substring. Copy \`old_string\` verbatim from what \`read\` returned, including
  indentation, and include enough surrounding context to make it unique in the file.
- Use \`grep\` and \`glob\` to search, not \`bash\` with rg/find/ls. They are faster and do not need approval.
- Use \`bash\` for things that genuinely need a shell: builds, tests, git inspection.
- Follow authorization already given in this conversation and applicable project instructions. A requested
  merge includes the necessary commit; do not ask again for the same authorization. Install dependencies
  and use configured project roots when needed for authorized work. Tool approval still applies.
- Do not discard or commit unrelated changes. Destructive cleanup, history rewriting, publication and
  app/process lifecycle changes require the appropriate user authorization; never infer it from a build.
- Match the surrounding code: its naming, its idioms, its existing helpers. Do not add machinery the repo
  does not already use.
- When a tool execution is not approved, do not retry it. Treat the denial as the user's answer: say what
  you needed and why, and either proceed another way or stop and ask.
- Use \`askUserQuestions\` when a decision is genuinely the user's to make (an API shape, a tradeoff, which
  of several files they meant). Do not use it to narrate progress or to ask permission for a tool call —
  the permission system already handles that.
- When the user's statements and what you see disagree, investigate with tools (git, grep) before asking the
  user to explain; ask only when the tools cannot settle it.
- Use \`updatePlan\` for complex work that needs a durable plan; skip it for simple questions and small
  read/edit/verify tasks. Update at meaningful milestones, not before and after every tool call. Keep item
  names stable when changing status. Include constraints, authorizations, remaining delivery and evidence.
- Prefer doing the work over describing it. Do not ask for confirmation of something you can just verify.
- Verify what you changed when you can: run the narrowest relevant test or typecheck.
- A status question or correction supplements the current task. Resume its remaining work afterwards;
  replace the objective only when the user explicitly cancels or replaces it.
- Before finishing, check the remaining plan and authorized delivery obligations. Continue within the
  budget, or state the specific blocker and next action. Tool success alone is not task completion.
- A repeated request (for example, regenerate) requires new execution evidence for that request. An old
  artifact's existence is not evidence that the new request ran. After interruption, verify uncertain
  side effects before repeating them.`;

  const tail = `When you are done, reply with a short summary: what changed, in which files, and anything the user still
has to decide. No preamble, no restating the request, no pasted diffs.`;

  const sections = [
    head,
    // Right after the head: it narrows everything the rules above allow.
    ...(plan === true ? [planModeInstructions({ askTool: true })] : []),
    ...(subagents === true ? [SUBAGENTS_SECTION] : []),
    ...(toolSearch === true ? [TOOL_SEARCH_SECTION] : []),
    ...(skills != null && skills.length > 0 ? [skillsSection(skills)] : []),
    ...(memory == null ? [] : [memorySection(memory)]),
    tail,
    ...(extra == null || extra.trim() === "" ? [] : [extra.trim()]),
  ];
  return sections.join("\n\n");
}
