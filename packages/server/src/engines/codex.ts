import { codexProviderEnv, createCodexEngine, type CodexEngineOptions } from "@vgent/engines";
import { describeSubscriptionAuth, splitProviderModelSpec, type ProviderConfig } from "@vgent/providers";
import type { TextStreamPart, ToolSet } from "ai";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import { createProviderStore } from "../store/providers.js";
import type { EngineDescriptor } from "./capabilities.js";
import { stripDeniedApprovalResults } from "./harness-messages.js";
import { effectiveReasoningLevel } from "../reasoning.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/**
 * 引擎能力表, the Codex row. `update_plan` exists but produces no UI part, and
 * the harness has no built-in tool approval at all — so every Codex turn runs
 * 全自动, which `effectivePermission` is what decides.
 */
const DESCRIPTOR: EngineDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    approvals: false,
    askUser: false,
    planMode: false,
    compact: false,
    knownDefaultModel: false,
    extensions: false,
    customProviders: true,
  },
};

/**
 * A thread model of the form `<providerId>:<model>` runs on that provider's
 * endpoint and key instead of the machine's Codex login — the same split the
 * Claude Code engine makes. Anything else (a Codex slug, nothing) is the login's
 * business and yields `undefined`. A provider that is gone, or has no `codex`
 * endpoint, is refused rather than sent to the ChatGPT backend as a model it
 * would reject.
 */
export function codexProviderRoute(model: string | undefined, providers: readonly ProviderConfig[]) {
  if (model == null) return undefined;
  const split = splitProviderModelSpec(model);
  if (split == null) return undefined;
  const provider = providers.find((entry) => entry.id === split.providerId);
  if (provider == null) {
    throw new BadRequestError(`没有叫 ${JSON.stringify(split.providerId)} 的提供商，可能已被删除；请给这个任务换一个模型`, "invalid_model");
  }
  const agent = provider.agents.codex;
  if (agent == null) throw new BadRequestError(`提供商「${provider.name}」没有给 Codex 配置接入地址`, "invalid_model");
  // Codex only carries metadata for OpenAI's own models; for anything else it falls back to a guess unless told.
  const contextWindow = agent.models.find((entry) => entry.id === split.modelId)?.contextWindow;
  return {
    model: split.modelId,
    auth: codexProviderEnv({ baseURL: agent.baseURL, ...(provider.apiKey != null ? { apiKey: provider.apiKey } : {}) }),
    ...(contextWindow != null ? { codexConfig: { model_context_window: contextWindow } } : {}),
  };
}

/**
 * The Codex harness takes a `reasoningEffort` of its own
 * (`CodexHarnessSettings.reasoningEffort`), but only these five values; the
 * catalog can list others (a model row may offer `none`, say), so a level the
 * CLI would reject is dropped rather than passed on.
 */
const CODEX_EFFORTS: ReadonlyArray<NonNullable<CodexEngineOptions["reasoningEffort"]>> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function asCodexEffort(level: string | undefined): CodexEngineOptions["reasoningEffort"] | undefined {
  return CODEX_EFFORTS.find((effort) => effort === level);
}

/**
 * The real Codex engine, one harness session per thread.
 *
 * Resume strategy is the Claude Code one: the thread id *is* the harness
 * `sessionId`, a finished turn ends with `stop()` (runtime and sandbox down,
 * resume state persisted), and the next turn passes that state back as
 * `resumeFrom`.
 *
 * Unlike Claude Code, a Codex turn can never end unfinished: the adapter
 * reports `supportsBuiltinToolApprovals: false` and this engine passes no host
 * `tools`, so nothing can pause a turn waiting on the human. `hasUnfinishedTurn`
 * still reports what the session says rather than a hard `false`, so the run
 * manager keeps making the safe choice if that ever changes.
 */
export function createCodexEngineFactory(): EngineFactory {
  return {
    descriptor: DESCRIPTOR,

    async ensureAvailable({ thread }) {
      // A provider's model runs on the provider's key; the login is not needed, so its absence is no obstacle.
      if (thread.model != null && splitProviderModelSpec(thread.model) != null) return;
      // The adapter's `auth: 'auto'` reads the same store this reports on.
      const report = await describeSubscriptionAuth();
      if (!report.codex.available) {
        throw new EngineUnavailableError("Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）");
      }
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      const reasoningEffort = asCodexEffort(effectiveReasoningLevel(ctx.thread.reasoningEffort));
      const route = codexProviderRoute(ctx.thread.model, await createProviderStore(ctx.dataDir, ctx.log).list());
      const model = route?.model ?? ctx.thread.model;
      // Fast is Codex's own `service_tier` config key, set to the id its catalog
      // advertises for the model (`priority`). A tier the model does not
      // advertise is dropped by the CLI itself, with a warning, not an error.
      const tier = ctx.thread.serviceTier;
      const codexConfig =
        route?.codexConfig != null || tier != null
          ? { ...route?.codexConfig, ...(tier != null ? { service_tier: tier } : {}) }
          : undefined;
      const engine = await createCodexEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.permissionMode,
        ...(model != null ? { model } : {}),
        ...(route != null ? { auth: route.auth } : {}),
        ...(codexConfig != null ? { codexConfig } : {}),
        ...(reasoningEffort != null ? { reasoningEffort } : {}),
        sessionId: ctx.thread.id,
        // Codex turns never park, so a `continueFrom` can never be there to honour.
        ...(ctx.harnessState?.resumeFrom != null ? { resumeFrom: ctx.harnessState.resumeFrom } : {}),
      });

      let ended = false;

      return {
        hasUnfinishedTurn: () => engine.session.hasUnfinishedTurn(),

        async stream({ messages, abortSignal }) {
          // The whole converted history goes in on purpose; the harness session
          // owns its own native history and collapses the array to its last
          // `role: 'user'` message.
          // `options: undefined` is required by the call-options generic; this agent has no `callOptionsSchema`.
          // A Codex turn cannot pause on an approval today, so the deny fix-up
          // is a no-op here — it is applied anyway so both harness runners hand
          // the agent the same shape.
          const result = await engine.harnessAgent.stream({
            session: engine.session,
            messages: stripDeniedApprovalResults(messages),
            abortSignal,
            options: undefined,
          });
          return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
        },

        async destroy() {
          if (ended) return;
          ended = true;
          await engine.dispose().catch((error) => ctx.log.warn(`销毁 Codex session 失败 (thread ${ctx.thread.id})`, error));
        },

        async finish() {
          if (ended) return;
          ended = true;
          try {
            const resumeFrom = await engine.stop();
            await ctx.saveHarnessState({
              version: 1,
              sessionId: ctx.thread.id,
              resumeFrom,
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            ctx.log.warn(`保存 Codex resume 状态失败 (thread ${ctx.thread.id})`, error);
            await engine.dispose().catch(() => {});
          }
        },
      };
    },
  };
}
