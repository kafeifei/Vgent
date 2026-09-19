import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createModelRegistry, type ProviderConfig } from "@vgent/providers";
import { createCodingTools } from "@vgent/tools";
import { ToolLoopAgent, isStepCount, pruneMessages, toolSearch, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { askUserQuestionsTool } from "./ask-user-questions.js";
import { buildInstructions, type VgentContext } from "./instructions.js";
import { hasDeferredTools } from "./mcp.js";
import { createMemoryTool } from "./memory.js";
import { createToolApproval, type PermissionMode } from "./permissions.js";
import { appendSession } from "./session-store.js";
import type { SkillSummary } from "./skills.js";
import { createSubagentTools } from "./subagents.js";
import { updatePlanTool } from "./update-plan.js";

/** Prefix that routes a model string to the machine's ChatGPT/Codex login instead of the gateway. */
export const CODEX_SUBSCRIPTION_PREFIX = "codex-subscription:";

/**
 * The only tools a 计划 turn is given. Read-only by construction rather than by
 * policy: `write` / `edit` / `bash` / `coder` / `memory` and every MCP tool are
 * simply not in the set, so there is nothing for the model to be denied.
 * `explore`'s own child is read-only too, and `askUserQuestions` / `updatePlan`
 * only ever reach the user interface.
 */
const PLAN_TOOL_NAMES = ["read", "grep", "glob", "explore", "askUserQuestions", "updatePlan"] as const;

const DEFAULT_MAX_STEPS = 100;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 150_000;

/** A lifecycle summary forwarded to `onEvent`. Never carries token counts or tool payloads. */
export type VgentEngineEvent =
  | { type: "step-end"; stepNumber: number; finishReason: string; toolNames: string[] }
  | { type: "tool-end"; toolName: string; durationMs: number; ok: boolean };

export interface VgentEngineOptions {
  /**
   * The model to drive the loop. A `LanguageModel` is used as-is. A string goes
   * through the model registry: `codex-subscription:<id>` is the machine's
   * Codex CLI login, `<providerId>:<id>` a provider from {@link providers}, and
   * a bare `creator/model` the AI Gateway.
   */
  model: LanguageModel | string;
  /** The providers from the settings page, which is what makes `<providerId>:<id>` resolvable. */
  providers?: readonly ProviderConfig[];
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
  /**
   * Tools the user already approved for this task, whatever the mode says. The
   * caller re-reads them per turn, so a list grown mid-turn only takes effect
   * on the next one; the web UI answers the rest of that turn client-side.
   */
  alwaysAllow?: readonly string[];
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
  /**
   * Run this turn as a 计划 turn: only {@link PLAN_TOOL_NAMES} are offered, and
   * the system prompt says what the plan document has to look like.
   */
  plan?: boolean;
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
  /**
   * Directory the `memory` tool keeps its entries in — outside the repository,
   * shared by every task of the project. Omitted, the tool is not offered at
   * all and the prompt says nothing about memory.
   */
  memoryDir?: string;
  /**
   * How hard the model is asked to think, and whether it has to show its work.
   * Only reaches models that take the OpenAI Responses reasoning options — see
   * {@link reasoningProviderOptions}; anything else ignores it.
   */
  reasoning?: VgentReasoningOptions;
  /**
   * `serviceTier` on the OpenAI Responses API (`priority` is what ChatGPT /
   * Codex sells as Fast). Like `reasoning`, it is only sent to a model
   * {@link usesOpenAIReasoning} recognises; anything else ignores it.
   */
  serviceTier?: string;
}

export interface VgentReasoningOptions {
  /**
   * `reasoningEffort` on the OpenAI Responses API: `low` / `medium` / `high` /
   * `xhigh` / `max`. Which of those a given model accepts varies, so this stays
   * a plain string and the model catalog is what offers the choices. Unset
   * leaves the provider's own default.
   */
  effort?: string;
  /**
   * Whether to ask for a reasoning summary. Defaults to true, and that default
   * is the point: the ChatGPT/Codex backend returns its reasoning *encrypted*,
   * so without `reasoningSummary` every turn arrives with empty reasoning parts
   * and the UI has nothing to show.
   */
  summary?: boolean;
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
 * without constructing an agent. The spellings and their errors live in the
 * registry (`@vgent/providers`), which is also what the server's precondition
 * check reads — one source for both.
 */
export function resolveModel(model: LanguageModel | string, providers: readonly ProviderConfig[] = []): LanguageModel {
  if (typeof model !== "string") return model;
  return createModelRegistry({ providers }).languageModel(model);
}

/** The memory entries that already exist, for the prompt. A directory nobody wrote to yet is simply empty. */
function memoryEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * True for the models that take the OpenAI Responses reasoning options: the
 * machine's Codex subscription login, and OpenAI models routed through the
 * gateway. A resolved model is matched too (`codex-subscription.responses`, or
 * the gateway carrying an `openai/…` id), so a caller that builds the model
 * itself is not silently left without reasoning.
 */
export function usesOpenAIReasoning(model: LanguageModel | string): boolean {
  if (typeof model === "string") return model.startsWith(CODEX_SUBSCRIPTION_PREFIX) || model.startsWith("openai/");
  return model.provider.startsWith("codex-subscription") || model.modelId.startsWith("openai/");
}

/**
 * The `providerOptions` a reasoning-capable OpenAI model is driven with.
 *
 * `reasoningSummary` and `reasoningEffort` are the two documented reasoning
 * options of `@ai-sdk/openai`'s Responses models. The summary is what turns the
 * otherwise encrypted reasoning into text parts the UI can render, so `'auto'`
 * is requested unless the caller explicitly opts out.
 */
export function reasoningProviderOptions(
  model: LanguageModel | string,
  reasoning: VgentReasoningOptions = {},
  serviceTier?: string,
): { openai: Record<string, string> } | undefined {
  if (!usesOpenAIReasoning(model)) return undefined;
  const openai = {
    ...(reasoning.summary === false ? {} : { reasoningSummary: "auto" }),
    ...(reasoning.effort != null && reasoning.effort !== "" ? { reasoningEffort: reasoning.effort } : {}),
    ...(serviceTier != null && serviceTier !== "" ? { serviceTier } : {}),
  };
  return Object.keys(openai).length === 0 ? undefined : { openai };
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
  const { sessionFile, onEvent, skills, memoryDir } = options;
  const model = resolveModel(options.model, options.providers);
  const subagents = options.subagents !== false;

  const plan = options.plan === true;

  const all: ToolSet = {
    ...createCodingTools({ workDir: repoPath }),
    askUserQuestions: askUserQuestionsTool,
    updatePlan: updatePlanTool,
    // Only the top-level agent remembers: a subagent is handed everything it
    // needs and has no conversation of its own worth carrying across tasks.
    ...(memoryDir == null ? {} : { memory: createMemoryTool(memoryDir) }),
    ...(subagents
      ? createSubagentTools({
          model: options.subagentModel == null ? model : resolveModel(options.subagentModel, options.providers),
          repoPath,
          permissionMode,
          ...(options.alwaysAllow == null ? {} : { alwaysAllow: options.alwaysAllow }),
        })
      : {}),
    ...options.extraTools,
  };
  const tools: ToolSet = plan
    ? Object.fromEntries(PLAN_TOOL_NAMES.filter((name) => all[name] != null).map((name) => [name, all[name]!]))
    : all;
  // Deferred tools are invisible to the model until something looks them up.
  // A 计划 turn has none — no MCP tool survived the filter — so it gets no
  // `toolSearch` either.
  const deferred = !plan && hasDeferredTools(tools);
  if (deferred) tools.toolSearch = toolSearch();

  // The TUI and the web UI both hand the agent a prompt, not a message list, so
  // there is no call site that could persist a turn. The hooks have to live on
  // the agent. `onStart` sees the standardized prompt (everything sent to the
  // model on this call), `onEnd` sees only what the model produced; together
  // they cover the turn. `persisted` skips what earlier turns already wrote,
  // since each call re-sends the whole history.
  let persisted = 0;

  // Keyed on the string the caller named when there is one, so a spec that was
  // just resolved is still recognised for what it is.
  const providerOptions = reasoningProviderOptions(
    typeof options.model === "string" ? options.model : model,
    options.reasoning ?? {},
    options.serviceTier,
  );

  const agent = new ToolLoopAgent({
    model,
    // Merged with, not replacing, the defaults `createCodexSubscriptionModel`
    // pins on the model (`store: false`): `defaultSettingsMiddleware` merges
    // provider options and lets the call's own win.
    ...(providerOptions == null ? {} : { providerOptions }),
    instructions: buildInstructions({
      repoPath,
      ...(options.context == null ? {} : { context: options.context }),
      permissionMode,
      subagents,
      ...(plan ? { plan: true } : {}),
      toolSearch: deferred,
      ...(skills == null ? {} : { skills }),
      // The tool did not survive the Plan filter, so the prompt must not
      // advertise it either.
      ...(memoryDir == null || plan ? {} : { memory: { dir: memoryDir, entries: memoryEntries(memoryDir) } }),
      ...(options.instructions == null ? {} : { extra: options.instructions }),
    }),
    tools,
    toolApproval: createToolApproval(permissionMode, options.alwaysAllow),
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
