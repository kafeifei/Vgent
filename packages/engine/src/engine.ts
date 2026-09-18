import { resolve } from "node:path";
import { createApiKeyModel, createCodexSubscriptionModel } from "@vgent/providers";
import { createCodingTools } from "@vgent/tools";
import { ToolLoopAgent, isStepCount, pruneMessages, toolSearch, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { askUserQuestionsTool } from "./ask-user-questions.js";
import { buildInstructions, type VgentContext } from "./instructions.js";
import { hasDeferredTools } from "./mcp.js";
import { createToolApproval, type PermissionMode } from "./permissions.js";
import { appendSession } from "./session-store.js";
import type { SkillSummary } from "./skills.js";
import { createSubagentTools } from "./subagents.js";

/** Prefix that routes a model string to the machine's ChatGPT/Codex login instead of the gateway. */
export const CODEX_SUBSCRIPTION_PREFIX = "codex-subscription:";

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 150_000;

/** A lifecycle summary forwarded to `onEvent`. Never carries token counts or tool payloads. */
export type VgentEngineEvent =
  | { type: "step-end"; stepNumber: number; finishReason: string; toolNames: string[] }
  | { type: "tool-end"; toolName: string; durationMs: number; ok: boolean };

export interface VgentEngineOptions {
  /**
   * The model to drive the loop. A `LanguageModel` is used as-is. A string is
   * resolved as a gateway `provider/model` spec, except when it starts with
   * `codex-subscription:`, which uses the machine's Codex CLI login.
   */
  model: LanguageModel | string;
  /** Repository the agent works in. Tools are confined to it. */
  repoPath: string;
  /**
   * Who and where the agent is — the model string the host picked, the front
   * end it answers through, the worktree it sits in. Goes into the system
   * prompt; see `VgentContext`.
   */
  context?: VgentContext;
  /** What may run without asking. Defaults to `allow-edits`. */
  permissionMode?: PermissionMode;
  /** Extra guidance appended to the engine's own system prompt. */
  instructions?: string;
  /** JSONL file the turn's messages are appended to. Omit for no persistence. */
  sessionFile?: string;
  /** Hard cap on loop steps. Defaults to 100. */
  maxSteps?: number;
  /** Estimated prompt tokens above which messages are pruned. Defaults to 150000. */
  contextTokenBudget?: number;
  /** Lifecycle summaries, for logging. */
  onEvent?: (event: VgentEngineEvent) => void;
  /** Whether the `explore` / `coder` subagent tools are offered. Defaults to true. */
  subagents?: boolean;
  /** The model the subagents run on. Defaults to `model`. */
  subagentModel?: LanguageModel | string;
  /**
   * Tools merged in on top of the built-ins — MCP servers, in practice (see
   * `connectMcpServers`). When any of them is `deferLoading`, `toolSearch` is
   * added so the model can still find them.
   */
  extraTools?: ToolSet;
  /** The skills index for the system prompt. Names and descriptions only; see `loadSkillsIndex`. */
  skills?: readonly SkillSummary[];
}

/**
 * The engine's agent type. `ToolLoopAgent` implements the AI SDK `Agent`
 * interface, so a value of this type goes straight into `runAgentTUI({ agent })`
 * or `createAgentUIStreamResponse({ agent })` with no wrapper.
 */
export type VgentAgent = ToolLoopAgent<unknown, ToolSet>;

export interface VgentEngine {
  agent: VgentAgent;
  /**
   * The exact tool set the agent runs with. Callers that store the turn as UI
   * messages need it: `toModelOutput` (the subagents' summaries) is applied by
   * `convertToModelMessages`, and only when it is given these same tools.
   */
  tools: ToolSet;
  /** Symmetry with the harness engines, which hold processes. Nothing to release here yet. */
  dispose(): Promise<void>;
}

/**
 * Resolves the `model` option. Kept separate so the string forms are testable
 * without constructing an agent.
 */
export function resolveModel(model: LanguageModel | string): LanguageModel {
  if (typeof model !== "string") return model;
  if (model.startsWith(CODEX_SUBSCRIPTION_PREFIX)) {
    const modelId = model.slice(CODEX_SUBSCRIPTION_PREFIX.length);
    if (modelId === "") throw new Error(`Missing model id after "${CODEX_SUBSCRIPTION_PREFIX}".`);
    return createCodexSubscriptionModel(modelId);
  }
  return createApiKeyModel(model);
}

/** Cheap prompt-size estimate: roughly four characters per token. */
function estimateTokens(messages: readonly ModelMessage[]): number {
  return JSON.stringify(messages).length / 4;
}

/**
 * Vgent's own coding engine: a plain `ToolLoopAgent` wired to `@vgent/tools`,
 * the permission mapping, and optional JSONL session persistence.
 *
 * It is deliberately *not* a HarnessV1 adapter. The SDK already owns the loop,
 * approvals and pruning; wrapping it in the harness contract would mean
 * reimplementing all three.
 */
export function createVgentEngine(options: VgentEngineOptions): VgentEngine {
  const repoPath = resolve(options.repoPath);
  const permissionMode: PermissionMode = options.permissionMode ?? "allow-edits";
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const contextTokenBudget = options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const { sessionFile, onEvent, skills } = options;
  const model = resolveModel(options.model);
  const subagents = options.subagents !== false;

  const tools: ToolSet = {
    ...createCodingTools({ workDir: repoPath }),
    askUserQuestions: askUserQuestionsTool,
    ...(subagents
      ? createSubagentTools({
          model: options.subagentModel == null ? model : resolveModel(options.subagentModel),
          repoPath,
          permissionMode,
        })
      : {}),
    ...options.extraTools,
  };
  // Deferred tools are invisible to the model until something looks them up.
  const deferred = hasDeferredTools(tools);
  if (deferred) tools.toolSearch = toolSearch();

  // The TUI and the web UI both hand the agent a prompt, not a message list, so
  // there is no call site that could persist a turn. The hooks have to live on
  // the agent. `onStart` sees the standardized prompt (everything sent to the
  // model on this call), `onEnd` sees only what the model produced; together
  // they cover the turn. `persisted` skips what earlier turns already wrote,
  // since each call re-sends the whole history.
  let persisted = 0;

  const agent = new ToolLoopAgent({
    model,
    instructions: buildInstructions({
      repoPath,
      ...(options.context == null ? {} : { context: options.context }),
      permissionMode,
      subagents,
      toolSearch: deferred,
      ...(skills == null ? {} : { skills }),
      ...(options.instructions == null ? {} : { extra: options.instructions }),
    }),
    tools,
    toolApproval: createToolApproval(permissionMode),
    stopWhen: [isStepCount(maxSteps)],
    prepareStep: ({ messages }) => {
      if (estimateTokens(messages) <= contextTokenBudget) return {};
      return {
        messages: pruneMessages({
          messages,
          reasoning: "all",
          toolCalls: "before-last-3-messages",
          emptyMessages: "remove",
        }),
      };
    },
    onStart: async ({ messages }) => {
      if (sessionFile == null) return;
      await appendSession(sessionFile, messages.slice(persisted));
      persisted = messages.length;
    },
    onEnd: async ({ responseMessages }) => {
      if (sessionFile == null) return;
      await appendSession(sessionFile, responseMessages);
      persisted += responseMessages.length;
    },
    onStepEnd: ({ stepNumber, finishReason, toolCalls }) => {
      onEvent?.({
        type: "step-end",
        stepNumber,
        finishReason,
        toolNames: toolCalls.map((call) => call.toolName),
      });
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
      onEvent?.({
        type: "tool-end",
        toolName: toolCall.toolName,
        durationMs: toolExecutionMs,
        ok: toolOutput.type === "tool-result",
      });
    },
  });

  return {
    agent,
    tools,
    dispose: async () => {},
  };
}
