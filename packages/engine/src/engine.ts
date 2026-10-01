import { restoreContext, saveContext } from "./context-cache.js";
import { observeProvider, type FailureClass } from "./failures.js";
import { createHash, randomUUID } from "node:crypto";
import { promptCaching } from "./prompt-caching.js";
import { isRuntimeContext } from "./runtime-context.js";
import { mkdir, writeFile } from "node:fs/promises";
import { fitContext, estimateTokens } from "./context.js";
import { resolve, join } from "node:path";
import { createModelRegistry, splitProviderModelSpec, type ProviderConfig } from "@vgent/providers";
import {
  ToolLoopAgent,
  asSchema,
  extractReasoningMiddleware,
  isStepCount,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { retryEmptyReply } from "./empty-reply.js";
import { askUserQuestionsTool } from "./ask-user-questions.js";
import type { VgentContext } from "./instructions.js";
import { createAgentSetup, type AgentSetupOptions } from "./agent-setup.js";
import { createMemoryTool } from "./memory.js";
import type { PermissionMode } from "./permissions.js";
import { appendSession } from "./session-store.js";
import type { SkillSummary } from "./skills.js";
import { createSubagentTools } from "./subagents.js";
import { createTaskPlan, type TaskState } from "./update-plan.js";

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
  /** Default working directory. File tools also use configured project and skill roots; shell commands run on the host. */
  repoPath: string;
  projectPath?: string;
  outputDir?: string;
  /** Stable task ID across turns; children use their own persistent task IDs. */
  sessionId?: string;
  taskState?: TaskState;
  saveTaskState?: (state: TaskState) => Promise<void>;
  memorySources?: readonly { id: string; text: string }[];
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
  /** Effective request input budget including instructions and tools; history is compacted to fit. */
  contextTokenBudget?: number;
  /** Lifecycle summaries, for logging. */
  onEvent?: (event: VgentEngineEvent) => void;
  /** Whether the `explore` / `coder` subagent tools are offered. Defaults to true. */
  subagents?: boolean;
  /** Whether the `updatePlan` to-do list is offered. Defaults to true. */
  todos?: boolean;
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
  /**
   * 插话: asked between steps for what the user has said since the turn began.
   * Whatever it returns is appended as `user` messages before the next step,
   * and must not be returned twice — the caller hands each message over once.
   */
  pendingUserMessages?: () => Promise<string[]>;
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
  outcome(): EngineOutcome;
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

/** What the AI SDK's provider-agnostic `reasoning` call setting accepts, besides the default. */
const PORTABLE_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PortableReasoningLevel = (typeof PORTABLE_REASONING_LEVELS)[number];

/**
 * 推理强度 for a model of a settings-page provider (`<providerId>:<model>`).
 * Those are built from whichever AI SDK package the provider's protocol names,
 * so the effort travels as the SDK's top-level `reasoning` setting and each
 * package turns it into its own wire format (`reasoning_effort`, Anthropic's
 * `effort`, …). Everything else keeps the behaviour it had: OpenAI Responses
 * models go through {@link reasoningProviderOptions}, the rest get nothing.
 */
export function portableReasoning(
  model: LanguageModel | string,
  providers: readonly ProviderConfig[],
  reasoning: VgentReasoningOptions = {},
): PortableReasoningLevel | undefined {
  if (typeof model !== "string") return undefined;
  const spec = splitProviderModelSpec(model);
  if (spec == null || !providers.some((provider) => provider.id === spec.providerId)) return undefined;
  return PORTABLE_REASONING_LEVELS.find((level) => level === reasoning.effort);
}

export interface EngineOutcome {
  model: string;
  provider: string;
  stopReason: "response" | "budget" | "empty" | "incomplete" | "error" | "unknown";
  steps: number;
  providerAttempts: number;
  finishReason?: string;
  errorClass?: FailureClass;
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
  const modelSpec = typeof options.model === "string" ? splitProviderModelSpec(options.model) : undefined;
  const advertisedWindow = modelSpec
    ? options.providers
        ?.find((provider) => provider.id === modelSpec.providerId)
        ?.agents.vgent?.models.find((entry) => entry.id === modelSpec.modelId)?.contextWindow
    : undefined;
  const contextTokenBudget = Math.min(
    options.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    advertisedWindow ? Math.floor(advertisedWindow * 0.8) : Infinity,
  );
  const { sessionFile, onEvent, skills, memoryDir } = options;
  const resolvedModel = resolveModel(options.model, options.providers) as Parameters<typeof wrapLanguageModel>[0]["model"];
  const sessionId = options.sessionId ?? (sessionFile
    ? createHash("sha256").update(resolve(sessionFile)).digest("hex")
    : randomUUID());
  const caching = promptCaching(resolvedModel, sessionId, options.providers);
  const outcome: EngineOutcome = {
    model: resolvedModel.modelId,
    provider: resolvedModel.provider,
    stopReason: "unknown",
    steps: 0,
    providerAttempts: 0,
  };
  let turnSignal: AbortSignal | undefined;
  let usageRatio = 1;
  let lastEstimate = 0;
  let toolsMayRun = true;
  const planState = createTaskPlan(options.taskState, options.saveTaskState);
  const model = wrapLanguageModel({
    model: resolvedModel,
    // Some OpenAI-compatible gateways put the model's reasoning summary into the
    // answer as `<thinking>…</thinking>`; it is taken back out as reasoning
    // before the empty-reply check looks at what is left.
    middleware: [
      retryEmptyReply(),
      extractReasoningMiddleware({ tagName: "thinking" }),
      observeProvider(
        () => {
          outcome.providerAttempts += 1;
        },
        (kind) => {
          outcome.errorClass = kind;
        },
      ),
    ],
  });
  const subagents = options.subagents !== false;
  const subagentModel = subagents ? (options.subagentModel == null ? model : resolveModel(options.subagentModel, options.providers)) : undefined;

  const plan = options.plan === true;

  const setupOptions: AgentSetupOptions = {
    repoPath,
    projectPath: options.projectPath,
    outputDir: options.outputDir,
    permissionMode,
    alwaysAllow: options.alwaysAllow?.slice(),
    context: options.context,
    skills,
    instructions: options.instructions,
  };
  const setup = createAgentSetup({
    ...setupOptions,
    model: resolvedModel,
    providers: options.providers,
    plan,
    ...(plan ? { allowedTools: PLAN_TOOL_NAMES } : {}),
    canExecute: () => toolsMayRun,
    extraTools: {
      askUserQuestions: askUserQuestionsTool,
      ...(options.todos === false ? {} : { updatePlan: planState.tool }),
      ...(memoryDir == null ? {} : { memory: createMemoryTool(memoryDir, options.memorySources) }),
      ...(subagents
        ? createSubagentTools({
            ...setupOptions,
            model: subagentModel!,
            providers: options.providers,
            // Expose supported reasoning summaries; retain the child's default effort.
            providerOptions: reasoningProviderOptions(subagentModel!, options.reasoning?.summary === false ? { summary: false } : {}),
            contextTokenBudget,
            taskContext: () => JSON.stringify(planState.get() ?? {}),
          })
        : {}),
      ...options.extraTools,
    },
  });
  const { tools } = setup;

  // The TUI and the web UI both hand the agent a prompt, not a message list, so
  // there is no call site that could persist a turn. The hooks have to live on
  // the agent. `onStart` sees the standardized prompt (everything sent to the
  // model on this call), `onEnd` sees only what the model produced; together
  // they cover the turn. `persisted` skips what earlier turns already wrote,
  // since each call re-sends the whole history.
  let persisted = 0;
  let steered = false;
  // This turn's history differs from the stored transcript: restored from, or
  // newly cut by, a compaction.
  let rewritten = false;

  // Keyed on the string the caller named when there is one, so a spec that was
  // just resolved is still recognised for what it is.
  const reasoningOptions = reasoningProviderOptions(
    typeof options.model === "string" ? options.model : model,
    options.reasoning ?? {},
    options.serviceTier,
  );

  const providerOptions = caching.providerOptions || reasoningOptions ? {
    ...caching.providerOptions,
    ...reasoningOptions,
    openai: { ...caching.providerOptions?.openai, ...reasoningOptions?.openai },
  } : undefined;

  const reasoning = portableReasoning(options.model, options.providers ?? [], options.reasoning);

  const agent = new ToolLoopAgent({
    model,
    ...caching,
    ...(reasoning == null ? {} : { reasoning }),
    // Merged with, not replacing, the defaults `createCodexSubscriptionModel`
    // pins on the model (`store: false`): `defaultSettingsMiddleware` merges
    // provider options and lets the call's own win.
    ...(providerOptions == null ? {} : { providerOptions }),
    instructions: setup.instructions,
    tools,
    toolApproval: setup.toolApproval,
    stopWhen: [isStepCount(maxSteps)],
    prepareStep: async ({ messages, stepNumber, initialInstructions, initialMessages, responseMessages }) => {
      // 插话: what the user said while the last step ran is put in front of the
      // model now. The list this returns becomes the base of every later step,
      // so a message goes in once. Not before the first step — that one is
      // already answering a message, and the rest of a queue is not a reply to it.
      const said = stepNumber > 0 ? ((await options.pendingUserMessages?.()) ?? []) : [];
      if (said.length > 0) steered = true;
      const current = said.length === 0 ? messages : [...messages, ...said.map((text): ModelMessage => ({ role: "user", content: text }))];
      // Everything the model is told up front is fixed for the whole turn, and
      // the history only grows at its end. Anything else rewrites the start of
      // the request and throws the provider's prompt cache away from there on.
      const closing = stepNumber >= maxSteps - 1 && maxSteps > 1;
      toolsMayRun = !closing;
      const instructions =
        initialInstructions +
        (closing
          ? "\nExecution budget is nearly exhausted. Make no further tool calls; report verified progress, remaining work and the next action. Do not claim the task is complete without evidence."
          : "");
      let restored = stepNumber === 0 && options.outputDir ? await restoreContext(options.outputDir, current) : current;
      // Older builds put state snapshots into the history; protocols without mid-conversation system messages reject them.
      if (caching.allowSystemInMessages !== true && restored.some(isRuntimeContext)) restored = restored.filter((message) => !isRuntimeContext(message));
      if (restored !== current) rewritten = true;
      const overhead =
        estimateTokens(instructions) +
        estimateTokens(
          await Promise.all(
            Object.entries(tools)
              // Hosted search returns loaded schemas in message history, already counted by
              // fitContext. The deferred catalog is not part of the model's initial context.
              .filter(([, definition]) => !definition.deferLoading && definition.providerOptions?.openai?.deferLoading !== true)
              .map(async ([name, definition]) => ({
                name,
                description: definition.description,
                inputSchema: await asSchema(definition.inputSchema).jsonSchema,
              })),
          ),
        );
      const fitted = await fitContext({
        messages: restored,
        model,
        budget: contextTokenBudget,
        overhead: overhead + 1024,
        ratio: usageRatio,
        ...(turnSignal ? { abortSignal: turnSignal } : {}),
        ...(options.outputDir
          ? {
              archive: async (history: ModelMessage[]) => {
                await mkdir(options.outputDir!, { recursive: true, mode: 0o700 });
                const path = join(options.outputDir!, `context-${randomUUID()}.json`);
                await writeFile(path, JSON.stringify(history), { mode: 0o600 });
                return path;
              },
            }
          : {}),
      });
      if (fitted.compacted) rewritten = true;
      // The next turn starts from the stored transcript again; this maps it onto
      // the compacted history, so that turn reads the same summary on the same
      // cached prefix. A 插话 is not in the SDK's originals, so a steered turn
      // keeps the last mapping that still matches. Exact-prefix validation
      // rejects edited history and any transcript that converts differently.
      if (options.outputDir && rewritten && !steered) {
        await saveContext(options.outputDir, [...initialMessages, ...responseMessages], fitted.messages);
      }
      const effective = fitted.messages;
      lastEstimate = estimateTokens(effective) + overhead;
      if (closing) outcome.stopReason = "budget";
      return {
        messages: effective,
        instructions,
        ...(closing ? { activeTools: [], toolChoice: "none" as const } : {}),
      };
    },
    onStart: async ({ messages }) => {
      toolsMayRun = true;
      steered = false;
      rewritten = false;
      outcome.steps = 0;
      outcome.providerAttempts = 0;
      outcome.stopReason = "unknown";
      delete outcome.errorClass;
      delete outcome.finishReason;
      if (sessionFile == null) return;
      await appendSession(sessionFile, messages.slice(persisted));
      persisted = messages.length;
    },
    onEnd: async ({ responseMessages, finishReason, text }) => {
      outcome.finishReason = finishReason;
      if (outcome.stopReason !== "budget")
        outcome.stopReason =
          finishReason === "stop" && text.trim()
            ? "response"
            : finishReason === "error"
              ? "error"
              : finishReason === "length" || outcome.steps >= maxSteps
                ? "budget"
                : text.trim()
                  ? "incomplete"
                  : "empty";
      if (sessionFile == null) return;
      await appendSession(sessionFile, responseMessages);
      persisted += responseMessages.length;
    },
    onStepEnd: ({ stepNumber, finishReason, toolCalls, usage }) => {
      outcome.steps = stepNumber + 1;
      if (lastEstimate > 0 && usage.inputTokens != null) usageRatio = Math.max(usageRatio, usage.inputTokens / lastEstimate);
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

  // A VgentEngine is scoped to one live turn; retain the caller's signal for nested compaction.
  const stream = agent.stream.bind(agent);
  agent.stream = (input) => {
    turnSignal = input.abortSignal;
    return stream(input);
  };
  const generate = agent.generate.bind(agent);
  agent.generate = (input) => {
    turnSignal = input.abortSignal;
    return generate(input);
  };
  return {
    agent,
    tools,
    outcome: () => ({ ...outcome }),
    dispose: async () => {},
  };
}
