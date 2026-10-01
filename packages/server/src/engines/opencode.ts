import { collectHarnessAgentToolApprovalContinuations, collectHarnessAgentToolResultContinuations } from "@ai-sdk/harness/agent";
import { CODEX_SUBSCRIPTION_PREFIX, agentInstructionsSection, loadAgentInstructions, planModeInstructions } from "@vgent/engine";
import { createOpenCodeEngine, openCodeAuthContent } from "@vgent/engines";
import {
  describeSubscriptionAuth,
  getCodexTokenProvider,
  openCodeProviderConfig,
  openCodeProviderId,
  splitProviderModelSpec,
  type ProviderConfig,
} from "@vgent/providers";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TextStreamPart, ToolSet } from "ai";
import { DEFAULT_ACCOUNT, splitAccountSpec } from "../accounts/spec.js";
import type { AccountId } from "../accounts/types.js";
import { BadRequestError, EngineUnavailableError, TurnResumeFailedError } from "../errors.js";
import { PROVIDER_DEFAULT_LEVEL, effectiveReasoningLevel } from "../reasoning.js";
import { createProviderStore } from "../store/providers.js";
import type { EngineDescriptor } from "./capabilities.js";
import { stripDeniedApprovalResults } from "./harness-messages.js";
import type { EngineAccounts, EngineContext, EngineFactory, EngineRunner } from "./registry.js";
import { NO_MODEL } from "./vgent.js";

/**
 * 引擎能力表, the OpenCode row. Manual compaction is left off: the adapter can
 * only compact between turns and reports it on the *next* turn's stream, and
 * OpenCode compacts on its own when the window fills anyway.
 */
const DESCRIPTOR: EngineDescriptor = {
  id: "opencode",
  label: "OpenCode",
  capabilities: {
    approvals: true,
    // OpenCode's `question` tool reaches the host as `askUserQuestions`.
    askUser: true,
    planMode: true,
    compact: false,
    // A task that names no model runs on the Codex login's default, like the in-house engine.
    extensions: false,
    // The harness's `experimental_steer`: the bridge prompts the busy OpenCode session, which takes it at its next step.
    steer: true,
    customProviders: true,
  },
};

/**
 * The harness turns OpenCode's "a file changed" notices into `fileChange` tool
 * calls of its own. The edit that caused one is already in the log, and the
 * task's changes come from git, so they would only be a second line for it.
 */
export function withoutFileChangeNotices(stream: ReadableStream<TextStreamPart<ToolSet>>): ReadableStream<TextStreamPart<ToolSet>> {
  return stream.pipeThrough(
    new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(part, controller) {
        if ((part.type === "tool-call" || part.type === "tool-result") && part.toolName === "fileChange" && part.toolCallId.startsWith("harness-file-change-")) return;
        controller.enqueue(part);
      },
    }),
  );
}

/** The built-in tools a 计划 turn leaves active, by their harness names; the host refuses the rest. */
const PLAN_ACTIVE_TOOLS = ["read", "grep", "glob", "ls", "todowrite"] as const;
const PLAN_INSTRUCTIONS = planModeInstructions({ askTool: false });

/** What one turn runs: OpenCode's `provider/model`, the config that defines it, and whose login pays for it. */
export interface OpenCodeRoute {
  model: string;
  /** The `provider` entry a settings-page provider needs; absent for the Codex login, which OpenCode already knows. */
  provider?: Record<string, unknown>;
  /** The Codex account whose ChatGPT login the turn runs on. */
  codexAccount?: AccountId;
}

/**
 * A thread's model as OpenCode runs it.
 *
 * - `codex-subscription:<slug>` (optionally `@<account>:` in front) is a Codex
 *   login's model: OpenCode's own `openai/<slug>`, on that account's token.
 * - `<provider>:<model>` is a settings-page provider's, under a namespaced
 *   OpenCode provider built from its `opencode` endpoint.
 *
 * Anything else is refused: OpenCode's own logins are deliberately not used,
 * so every model a task can pick is one Vgent can account for.
 */
export function openCodeRoute(
  model: string,
  providers: readonly ProviderConfig[],
  facts: { reasoning?: boolean; contextWindow?: number | undefined } = {},
): OpenCodeRoute {
  const { accountId, spec } = splitAccountSpec(model);
  if (spec.startsWith(CODEX_SUBSCRIPTION_PREFIX)) {
    const slug = spec.slice(CODEX_SUBSCRIPTION_PREFIX.length);
    return {
      model: `openai/${slug}`,
      codexAccount: accountId ?? DEFAULT_ACCOUNT.codex,
      // The subscription's window is the Codex catalog's, not the API's; say it so OpenCode compacts in time.
      ...(facts.contextWindow != null
        ? { provider: { openai: { models: { [slug]: { limit: { context: facts.contextWindow, output: 0 } } } } } }
        : {}),
    };
  }
  const split = splitProviderModelSpec(spec);
  if (split == null) throw new BadRequestError(`OpenCode 不认识这个模型：${JSON.stringify(model)}`, "invalid_model");
  const provider = providers.find((entry) => entry.id === split.providerId);
  if (provider == null) {
    throw new BadRequestError(`没有叫 ${JSON.stringify(split.providerId)} 的提供商，可能已被删除；请给这个任务换一个模型`, "invalid_model");
  }
  const id = openCodeProviderId(provider.id);
  const config = openCodeProviderConfig(provider, {
    [split.modelId]: { ...(facts.reasoning === true ? { reasoning: true } : {}), ...(facts.contextWindow != null ? { contextWindow: facts.contextWindow } : {}) },
  });
  if (config == null) throw new BadRequestError(`提供商「${provider.name}」没有给 OpenCode 配置接入地址`, "invalid_model");
  return { model: `${id}/${split.modelId}`, provider: { [id]: config } };
}

/**
 * The `instructions` for a turn. OpenCode reads the repository's AGENTS.md on
 * its own; what it does not know about is the user's global one
 * (`~/.agents/AGENTS.md`), which every other engine follows. Plan mode's
 * addendum follows it.
 */
export async function openCodeInstructions(repoPath: string, planMode: boolean, home = homedir()): Promise<string | undefined> {
  const globalOnly = (await loadAgentInstructions({ repoPath, home })).filter((file) => file.path === join(home, ".agents", "AGENTS.md"));
  const parts = [agentInstructionsSection(globalOnly), planMode ? PLAN_INSTRUCTIONS : ""].filter((part) => part !== "");
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface OpenCodeEngineFactoryOptions {
  accounts?: EngineAccounts;
  /**
   * What the model list says about a model — its window and whether it has
   * 思考 levels — for a task that chose no window. OpenCode is told both.
   */
  modelOf?: (model: string) => Promise<{ contextWindow?: number; reasoningLevels?: string[] } | undefined>;
}

/**
 * OpenCode over the official harness adapter, one harness session per thread.
 * The session lifecycle — `stop()` / `resumeFrom` after a finished turn,
 * parking and `suspend()` / `continueFrom` for one waiting on the human — is the
 * Claude Code engine's; see `createClaudeCodeEngineFactory` for why each step is
 * there.
 */
export function createOpenCodeEngineFactory(options: OpenCodeEngineFactoryOptions = {}): EngineFactory {
  const { accounts } = options;
  return {
    descriptor: DESCRIPTOR,

    async ensureAvailable({ thread }) {
      if (thread.model == null) throw new EngineUnavailableError(NO_MODEL);
      const { accountId, spec } = splitAccountSpec(thread.model);
      if (!spec.startsWith(CODEX_SUBSCRIPTION_PREFIX)) return;
      if (accountId != null) {
        await accounts?.ensure(accountId);
        return;
      }
      const home = accounts?.codexHome(DEFAULT_ACCOUNT.codex);
      const report = await describeSubscriptionAuth(home != null ? { env: { ...process.env, CODEX_HOME: home } } : {});
      if (!report.codex.available) throw new EngineUnavailableError("Codex 未登录：在「账号」里添加一个 Codex 账号");
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      const continueFrom = ctx.continuesTurn ? ctx.harnessState?.continueFrom : undefined;
      const resumeFrom = continueFrom == null ? ctx.harnessState?.resumeFrom : undefined;
      const model = ctx.thread.model;
      if (model == null) throw new EngineUnavailableError(NO_MODEL);
      const level = ctx.thread.reasoningEffort;
      const listed = await options.modelOf?.(model).catch(() => undefined);
      const route = openCodeRoute(model, await createProviderStore(ctx.dataDir, ctx.log).list(), {
        // 「不指定」 sends nothing; otherwise the model reasons, and OpenCode picks the matching variant.
        ...(level !== PROVIDER_DEFAULT_LEVEL && (listed?.reasoningLevels?.length ?? 0) > 0 ? { reasoning: true } : {}),
        contextWindow: ctx.thread.contextWindow ?? listed?.contextWindow,
      });
      // OpenCode's login store for this session: the Codex account's token, or nothing at all.
      const login =
        route.codexAccount != null
          ? await getCodexTokenProvider({ env: { ...process.env, CODEX_HOME: accounts?.codexHome(route.codexAccount) ?? join(homedir(), ".codex") } })
              .getAccessToken()
              .catch((error: unknown) => {
                ctx.log.warn(`读取 Codex 登录失败 (thread ${ctx.thread.id})`, error);
                throw new EngineUnavailableError("Codex 登录不可用：在「账号」里重新登录", "account_unavailable");
              })
          : undefined;
      const instructions = await openCodeInstructions(ctx.project.repoPath, ctx.planMode);

      const engine = await createOpenCodeEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.permissionMode,
        model: route.model,
        ...(level !== PROVIDER_DEFAULT_LEVEL ? { reasoningVariant: effectiveReasoningLevel(level) } : {}),
        ...(route.provider != null ? { openCodeConfig: { provider: route.provider } } : {}),
        env: { OPENCODE_AUTH_CONTENT: openCodeAuthContent(login) },
        ...(ctx.planMode ? { activeTools: PLAN_ACTIVE_TOOLS } : {}),
        ...(instructions != null ? { instructions } : {}),
        sessionId: ctx.thread.id,
        ...(continueFrom != null ? { continueFrom } : {}),
        ...(resumeFrom != null ? { resumeFrom } : {}),
      }).catch((error) => {
        if (continueFrom == null) throw error;
        throw new TurnResumeFailedError("服务重启后未能恢复这一轮，请重新发送", { cause: error });
      });

      let ended = false;
      let pendingContinuation = continueFrom != null;

      return {
        hasUnfinishedTurn: () => engine.session.hasUnfinishedTurn(),

        async stream({ messages, abortSignal }) {
          const harnessMessages = stripDeniedApprovalResults(messages);
          if (pendingContinuation) {
            pendingContinuation = false;
            const result = await engine.harnessAgent.continueStream({
              session: engine.session,
              toolApprovalContinuations: collectHarnessAgentToolApprovalContinuations({ messages: harnessMessages }),
              toolResultContinuations: collectHarnessAgentToolResultContinuations({ messages: harnessMessages }),
              abortSignal,
            });
            return { stream: withoutFileChangeNotices(result.stream as ReadableStream<TextStreamPart<ToolSet>>) };
          }
          const result = await engine.harnessAgent.stream({
            session: engine.session,
            messages: harnessMessages,
            abortSignal,
            options: undefined,
          });
          return { stream: withoutFileChangeNotices(result.stream as ReadableStream<TextStreamPart<ToolSet>>) };
        },

        // Resolves once OpenCode has queued the message on the busy session; it has no event for when a step takes it.
        steer: (text, messageId) => engine.harnessAgent.experimental_steer({ session: engine.session, text, messageId }),

        async destroy() {
          if (ended) return;
          ended = true;
          await engine.dispose().catch((error) => ctx.log.warn(`销毁 OpenCode session 失败 (thread ${ctx.thread.id})`, error));
        },

        async suspend() {
          if (ended) throw new Error(`OpenCode 引擎已经结束，无法挂起 (thread ${ctx.thread.id})`);
          const continueTurn = await engine.suspend();
          ended = true;
          return {
            version: 1,
            sessionId: ctx.thread.id,
            ...(ctx.harnessState?.resumeFrom != null ? { resumeFrom: ctx.harnessState.resumeFrom } : {}),
            continueFrom: continueTurn,
            updatedAt: new Date().toISOString(),
          };
        },

        async finish() {
          if (ended) return;
          ended = true;
          try {
            const state = await engine.stop();
            await ctx.saveHarnessState({
              version: 1,
              sessionId: ctx.thread.id,
              resumeFrom: state,
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            ctx.log.warn(`保存 OpenCode resume 状态失败 (thread ${ctx.thread.id})`, error);
            await engine.dispose().catch(() => {});
          }
        },
      };
    },
  };
}
