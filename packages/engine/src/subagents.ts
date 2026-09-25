import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fitContext, estimateTokens, SUMMARY_INSTRUCTIONS } from "./context.js";
import { agentInstructionsSection, loadScopedInstructions } from "./agent-instructions.js";
/**
 * Subagents packaged as tools: `explore` (read-only research) and `coder`
 * (delegated mechanical edits).
 *
 * Both follow the AI SDK's subagent pattern: the `execute` is an async
 * generator that yields the child's accumulated `UIMessage`, so the UI can
 * render the child's transcript live, while `toModelOutput` hands the *parent*
 * model only the child's closing summary. That asymmetry is the whole point —
 * the child may burn a large context exploring, the parent pays for a paragraph.
 */
import { createCodingTools } from "@vgent/tools";
import {
  ToolLoopAgent,
  asSchema,
  generateText,
  convertToModelMessages,
  isStepCount,
  readUIMessageStream,
  tool,
  toUIMessageStream,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { decideApproval, type PermissionMode } from "./permissions.js";

const EXPLORE_MAX_STEPS = 30;
const CODER_MAX_STEPS = 60;
/** How much of the child's closing text the parent model gets to see. */
const SUMMARY_MAX_CHARS = 4000;

const EXPLORE_INSTRUCTIONS = `You are Vgent's exploration subagent. You research a repository and report back; you never change it.

You only have read-only tools: \`read\`, \`grep\`, \`glob\`. Search broadly, read what matters, and stop as
soon as you can answer. Do not speculate about code you have not read.

IMPORTANT: your final response is the only thing the parent agent sees. Make it a self-contained answer:
what you found, in which files (absolute paths and line numbers), and anything the parent still has to
decide. No preamble, no narration of your search.`;

const CODER_INSTRUCTIONS = `You are Vgent's coding subagent. You carry out one delegated, already-decided change.

Work inside the change you were given. Read before you edit, match the surrounding code, and verify with the
narrowest relevant check when one exists. If the task turns out to need a decision nobody made (an API shape,
a behavioural tradeoff, files outside the stated scope), stop and say so instead of deciding yourself.

IMPORTANT: your final response is the only thing the parent agent sees. Make it a self-contained report:
what you changed, in which files, how you verified it, and anything left open. No preamble, no pasted diffs.`;

export interface CreateSubagentToolsOptions {
  /** The model the children run on. Normally the parent's own model. */
  model: LanguageModel;
  /** Repository the children work in. Same confinement as the parent's tools. */
  repoPath: string;
  /** The parent's mode. Enforced inside the children by denial, not by approval. */
  permissionMode: PermissionMode;
  /** Hard cap on each child's steps. Defaults to 30 for `explore` and 60 for `coder`. */
  maxSteps?: number;
  /** Tool names the parent has been granted standing approval for; threaded into the children's denial check. */
  alwaysAllow?: readonly string[];
  instructions?: string | undefined;
  readRoots?: readonly string[];
  projectPath?: string | undefined;
  outputDir?: string | undefined;
  contextTokenBudget?: number;
  taskContext?: () => string;
}

/**
 * A subagent's tools cannot ask for approval — there is no human in the child's
 * loop, and the SDK says so explicitly. So the mode is enforced the other way
 * round: anything that *would* have needed approval fails instead, and the
 * child reports the refusal in its summary.
 */
function denyUnapproved(tools: ToolSet, mode: PermissionMode, alwaysAllow?: readonly string[], canExecute?: () => boolean): ToolSet {
  const guarded: ToolSet = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    const execute = definition.execute as ((input: unknown, options: unknown) => unknown) | undefined;
    if (execute == null) {
      guarded[toolName] = definition;
      continue;
    }
    guarded[toolName] = {
      ...definition,
      execute: (input: unknown, options: unknown) => {
        (options as { abortSignal?: AbortSignal }).abortSignal?.throwIfAborted();
        if (canExecute?.() === false) throw new Error("Subtask budget exhausted; no new action was started.");
        if (decideApproval({ mode, toolName, input, ...(alwaysAllow == null ? {} : { alwaysAllow }) }) === "user-approval") {
          throw new Error(`子代理不能执行需要审批的操作：${toolName}（当前权限模式 ${mode}）`);
        }
        return execute(input, options);
      },
    } as ToolSet[string];
  }
  return guarded;
}

export interface ChildResult {
  taskId: string;
  status: "completed" | "incomplete" | "failed" | "cancelled";
  stopReason: string;
  summary: string;
  details?: string;
  transcript?: string;
}

/** Legacy transcripts remain readable, but are not silently treated as completed. */
export function summarizeSubagentMessage(message: UIMessage | undefined): string {
  const result = (message?.metadata as { subagentResult?: ChildResult } | undefined)?.subagentResult;
  if (result) return JSON.stringify(result);
  const text = message?.parts.findLast((part) => part.type === "text")?.text.trim();
  if (!text) return "子代理没有返回文本。状态未知，不能视为完成。";
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, 2000)}\n…（历史摘要已截断，完成状态未知）…\n${text.slice(-2000)}`;
}

async function* streamChild(
  options: CreateSubagentToolsOptions,
  kind: "explore" | "coder",
  prompt: string,
  abortSignal?: AbortSignal,
  resumeTaskId?: string,
): AsyncGenerator<UIMessage> {
  const taskId = resumeTaskId ?? randomUUID();
  const accessed = new Set<string>();
  let closing = false;
  const coding = createCodingTools({
    workDir: options.repoPath,
    ...(options.projectPath ? { writeRoots: [options.projectPath] } : {}),
    ...(options.readRoots ? { readRoots: options.readRoots } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
    onRead: async (path) => {
      accessed.add(path);
    },
  });
  const tools = denyUnapproved(
    kind === "coder" ? coding : Object.fromEntries(Object.entries(coding).filter(([name]) => ["read", "grep", "glob"].includes(name))),
    options.permissionMode,
    options.alwaysAllow,
    () => !closing,
  );
  const maxSteps = options.maxSteps ?? (kind === "coder" ? CODER_MAX_STEPS : EXPLORE_MAX_STEPS);
  const agent = new ToolLoopAgent({
    model: options.model,
    instructions: [
      kind === "coder" ? CODER_INSTRUCTIONS : EXPLORE_INSTRUCTIONS,
      options.instructions,
      options.taskContext?.(),
      "Keep the final report under 3000 characters: findings/changes, evidence, risks, unfinished work. State limitations explicitly.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    tools,
    stopWhen: [isStepCount(maxSteps)],
    prepareStep: async ({ messages, stepNumber, initialInstructions }) => {
      closing = stepNumber >= maxSteps - 1 && maxSteps > 1;
      const instructions = [
        initialInstructions,
        agentInstructionsSection(await loadScopedInstructions(options.repoPath, [...accessed])),
        closing ? "Budget exhausted: make no more tool calls. Summarize verified progress and remaining work." : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const fitted = await fitContext({
        model: options.model,
        messages,
        budget: options.contextTokenBudget ?? 150000,
        overhead:
          estimateTokens(instructions) +
          1024 +
          estimateTokens(
            await Promise.all(
              Object.entries(tools).map(async ([name, definition]) => ({
                name,
                description: definition.description,
                inputSchema: await asSchema(definition.inputSchema).jsonSchema,
              })),
            ),
          ),
        ...(abortSignal ? { abortSignal } : {}),
      });
      return { messages: fitted.messages, instructions, ...(closing ? { activeTools: [], toolChoice: "none" as const } : {}) };
    },
  });
  let history: UIMessage[] = [];
  if (resumeTaskId) {
    if (!options.outputDir || !z.uuid().safeParse(resumeTaskId).success)
      throw new Error("Invalid subtask resume ID or no persistent output directory.");
    const saved = JSON.parse(await readFile(join(options.outputDir, `child-${resumeTaskId}.json`), "utf8")) as {
      taskId?: string;
      kind?: string;
      messages?: UIMessage[];
    };
    if (saved.taskId !== resumeTaskId || saved.kind !== kind || !Array.isArray(saved.messages))
      throw new Error("Subtask state is incompatible; inspect its report before starting a new task.");
    history = saved.messages;
  }
  history = [
    ...history,
    {
      id: randomUUID(),
      role: "user",
      parts: [
        {
          type: "text",
          text: `${resumeTaskId ? "Resume carefully: verify uncertain prior side effects before retrying.\n" : ""}${prompt}`,
        },
      ],
    },
  ];
  let message: UIMessage = { id: taskId, role: "assistant", parts: [] };
  let finishReason = "unknown";
  let failure: string | undefined;
  try {
    const result = await agent.stream({
      messages: await convertToModelMessages(history, { tools, ignoreIncompleteToolCalls: true }),
      ...(abortSignal ? { abortSignal } : {}),
    });
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(part, controller) {
          if (part.type === "finish") finishReason = part.finishReason;
          if (part.type === "error") failure = part.error instanceof Error ? part.error.message : String(part.error);
          controller.enqueue(part);
        },
      }),
    );
    for await (const next of readUIMessageStream({
      stream: toUIMessageStream({ stream, onError: (error) => (error instanceof Error ? error.message : String(error)) }),
    })) {
      message = next;
      yield message;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const boundary = message.parts.findLastIndex(
    (part) => part.type === "step-start" || part.type.startsWith("tool-") || part.type === "dynamic-tool",
  );
  const text = message.parts
    .slice(boundary + 1)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  let summary = text || failure || "子任务没有最终报告，需要核实已执行操作后继续。";
  let summaryComplete = true;
  if (summary.length > SUMMARY_MAX_CHARS && !abortSignal?.aborted) {
    try {
      const condensed = await generateText({
        model: options.model,
        instructions: SUMMARY_INSTRUCTIONS,
        prompt: summary,
        maxOutputTokens: 1000,
        maxRetries: 0,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (!condensed.text.trim()) throw new Error("Empty summary");
      summary = condensed.text.trim();
    } catch {
      summaryComplete = false;
    }
  }
  let details: string | undefined;
  let transcript: string | undefined;
  if (options.outputDir) {
    await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
    details = join(options.outputDir, `child-${taskId}.md`);
    transcript = join(options.outputDir, `child-${taskId}.json`);
    await writeFile(details, text || summary, { mode: 0o600 });
    const temporary = `${transcript}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ taskId, kind, messages: [...history, message] }), { mode: 0o600 });
    await rename(temporary, transcript);
  }
  if (summary.length > SUMMARY_MAX_CHARS) {
    summaryComplete = false;
    summary = `${summary.slice(0, 1900)}\n[Report abbreviated; read details before deciding completion]\n${summary.slice(-1900)}`;
  }
  const status: ChildResult["status"] = abortSignal?.aborted
    ? "cancelled"
    : failure
      ? "failed"
      : finishReason === "stop" && text && !closing && summaryComplete
        ? "completed"
        : "incomplete";
  const subagentResult: ChildResult = {
    taskId,
    status,
    stopReason: abortSignal?.aborted ? "cancelled" : failure ? "error" : closing ? "budget" : !text ? "empty" : finishReason,
    summary,
    ...(details ? { details, ...(transcript ? { transcript } : {}) } : {}),
  };
  yield { ...message, metadata: { ...(message.metadata as object), subagentResult } };
}

/**
 * The two subagent tools. Their names are known to `decideApproval`: `explore`
 * counts as read-only, `coder` as an edit, so launching a `coder` needs the
 * user's approval in `allow-reads` exactly like a `write` would.
 */
export function createSubagentTools(options: CreateSubagentToolsOptions): ToolSet {
  return {
    explore: tool({
      description:
        "Delegate a read-only research task to an exploration subagent: where something is defined, how a " +
        "subsystem is wired, which files a pattern touches. It searches with its own context and returns a " +
        "summary, so use it instead of reading many files yourself. State what you already know, so it does " +
        "not repeat your work.",
      inputSchema: z.object({
        prompt: z.string().describe("The research task, self-contained: what to find and what is already known."),
        resume_task_id: z
          .uuid()
          .optional()
          .describe("Continue an existing subtask by the taskId in its result; prior transcript is loaded."),
        thoroughness: z.enum(["quick", "medium", "very thorough"]).optional().describe("How far to search. Defaults to medium."),
      }),
      execute: async function* ({ prompt, thoroughness, resume_task_id }, { abortSignal }) {
        const task = thoroughness == null ? prompt : `${prompt}\n\nThoroughness: ${thoroughness}.`;
        yield* streamChild(options, "explore", task, abortSignal, resume_task_id);
      },
      toModelOutput: ({ output }) => ({ type: "text", value: summarizeSubagentMessage(output) }),
    }),

    coder: tool({
      description:
        "Delegate one already-decided, mechanical change to a coding subagent: it reads, edits and verifies on " +
        "its own and returns a report. Give it the complete context — exact files, the change to make, how to " +
        "verify — because it cannot see this conversation. Decide the design yourself first; it will stop and " +
        "ask rather than choose.",
      inputSchema: z.object({
        task: z.string().describe("The change to make, self-contained: files, the edit, and how to verify it."),
        resume_task_id: z.uuid().optional().describe("Continue an existing subtask after verifying uncertain prior side effects."),
      }),
      execute: async function* ({ task, resume_task_id }, { abortSignal }) {
        yield* streamChild(options, "coder", task, abortSignal, resume_task_id);
      },
      toModelOutput: ({ output }) => ({ type: "text", value: summarizeSubagentMessage(output) }),
    }),
  };
}
