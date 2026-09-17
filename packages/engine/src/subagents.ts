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
}

/**
 * A subagent's tools cannot ask for approval — there is no human in the child's
 * loop, and the SDK says so explicitly. So the mode is enforced the other way
 * round: anything that *would* have needed approval fails instead, and the
 * child reports the refusal in its summary.
 */
function denyUnapproved(tools: ToolSet, mode: PermissionMode): ToolSet {
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
        if (decideApproval({ mode, toolName, input }) === "user-approval") {
          throw new Error(`子代理不能执行需要审批的操作：${toolName}（当前权限模式 ${mode}）`);
        }
        return execute(input, options);
      },
    } as ToolSet[string];
  }
  return guarded;
}

/** The child's closing text, capped — what `toModelOutput` gives the parent. */
export function summarizeSubagentMessage(message: UIMessage | undefined): string {
  const text = message?.parts.findLast((part) => part.type === "text")?.text.trim();
  if (text == null || text === "") return "子代理没有返回文本。";
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS)}\n…（摘要已截断）`;
}

/**
 * Runs a child agent and yields its `UIMessage` as it grows. Each yield is a
 * preliminary tool output; the last one is the tool's real output.
 */
async function* streamChild(
  agent: ToolLoopAgent<unknown, ToolSet>,
  prompt: string,
  abortSignal: AbortSignal | undefined,
): AsyncGenerator<UIMessage> {
  const result = await agent.stream({
    prompt,
    options: undefined,
    ...(abortSignal == null ? {} : { abortSignal }),
  });
  // The default `onError` masks every error as "An error occurred." — right for
  // a stream leaving a server, wrong here: this transcript never leaves the
  // machine, and the message it hides is usually our own denial text.
  const stream = toUIMessageStream({
    stream: result.stream,
    onError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  for await (const message of readUIMessageStream({ stream })) {
    yield message;
  }
}

/**
 * The two subagent tools. Their names are known to `decideApproval`: `explore`
 * counts as read-only, `coder` as an edit, so launching a `coder` needs the
 * user's approval in `allow-reads` exactly like a `write` would.
 */
export function createSubagentTools(options: CreateSubagentToolsOptions): ToolSet {
  const { model, repoPath, permissionMode, maxSteps } = options;
  const codingTools = createCodingTools({ workDir: repoPath });
  const readOnlyTools: ToolSet = Object.fromEntries(
    Object.entries(codingTools).filter(([name]) => name === "read" || name === "grep" || name === "glob"),
  );

  const exploreAgent = new ToolLoopAgent({
    model,
    instructions: EXPLORE_INSTRUCTIONS,
    tools: denyUnapproved(readOnlyTools, permissionMode),
    stopWhen: [isStepCount(maxSteps ?? EXPLORE_MAX_STEPS)],
  });

  const coderAgent = new ToolLoopAgent({
    model,
    instructions: CODER_INSTRUCTIONS,
    tools: denyUnapproved(codingTools, permissionMode),
    stopWhen: [isStepCount(maxSteps ?? CODER_MAX_STEPS)],
  });

  return {
    explore: tool({
      description:
        "Delegate a read-only research task to an exploration subagent: where something is defined, how a " +
        "subsystem is wired, which files a pattern touches. It searches with its own context and returns a " +
        "summary, so use it instead of reading many files yourself. State what you already know, so it does " +
        "not repeat your work.",
      inputSchema: z.object({
        prompt: z.string().describe("The research task, self-contained: what to find and what is already known."),
        thoroughness: z
          .enum(["quick", "medium", "very thorough"])
          .optional()
          .describe("How far to search. Defaults to medium."),
      }),
      execute: async function* ({ prompt, thoroughness }, { abortSignal }) {
        const task = thoroughness == null ? prompt : `${prompt}\n\nThoroughness: ${thoroughness}.`;
        yield* streamChild(exploreAgent, task, abortSignal);
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
      }),
      execute: async function* ({ task }, { abortSignal }) {
        yield* streamChild(coderAgent, task, abortSignal);
      },
      toModelOutput: ({ output }) => ({ type: "text", value: summarizeSubagentMessage(output) }),
    }),
  };
}
