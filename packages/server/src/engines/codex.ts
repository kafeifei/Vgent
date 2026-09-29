import { codexProviderEnv, type CodexEngineOptions } from "@vgent/engines";
import { describeSubscriptionAuth, splitProviderModelSpec, type ProviderConfig } from "@vgent/providers";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import { CUA_TOOLS, requireCuaDriver } from "../computer-use/cua.js";
import { createProviderStore } from "../store/providers.js";
import { createSettingsStore } from "../store/settings.js";
import type { EngineDescriptor } from "./capabilities.js";
import { createNativeCodexRunner } from "./codex-native.js";
import { effectiveReasoningLevel } from "../reasoning.js";
import type { EngineAccounts, EngineContext, EngineFactory, EngineRunner } from "./registry.js";
import { DEFAULT_ACCOUNT, splitAccountSpec } from "../accounts/spec.js";

/**
 * 引擎能力表, the Codex row. `update_plan` exists but produces no UI part, and
 * this native app-server path has no host approval UI — so every Codex turn runs
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
    steer: true,
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
 * Codex accepts these reasoning effort values; the
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
 * One native app-server process per active turn. The Codex thread id persists
 * across processes; an older harness resume payload also contains that id.
 * This path supports turn/steer and reports actual insertion via userMessage.
 */
export function createCodexEngineFactory(accounts?: EngineAccounts): EngineFactory {
  return {
    descriptor: DESCRIPTOR,

    async ensureAvailable({ thread }) {
      const { accountId, spec } = thread.model == null ? { spec: undefined } : splitAccountSpec(thread.model);
      // A provider's model runs on the provider's key; the login is not needed, so its absence is no obstacle.
      if (spec != null && splitProviderModelSpec(spec) != null) return;
      if (accountId != null) { await accounts?.ensure(accountId); return; }
      // The native runner's token provider reads the same login store.
      const home = accounts?.codexHome(DEFAULT_ACCOUNT.codex);
      const report = await describeSubscriptionAuth(home != null ? { env: { ...process.env, CODEX_HOME: home } } : {});
      if (!report.codex.available) throw new EngineUnavailableError("Codex 未登录：在「账号」里添加一个 Codex 账号");
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      const settings = await createSettingsStore(ctx.dataDir, ctx.log).get();
      const cuaBinary = settings.computerUseProvider === "cua" ? await requireCuaDriver() : undefined;
      const reasoningEffort = asCodexEffort(effectiveReasoningLevel(ctx.thread.reasoningEffort));
      // `@<account>:<slug>`: the same model on another Codex account's login.
      const { accountId, spec } = ctx.thread.model == null ? { spec: undefined } : splitAccountSpec(ctx.thread.model);
      const route = codexProviderRoute(spec, await createProviderStore(ctx.dataDir, ctx.log).list());
      const model = route?.model ?? spec;
      const codexHome = route == null ? accounts?.codexHome(accountId ?? DEFAULT_ACCOUNT.codex) : undefined;
      // The native runner loads the full catalog before process startup, so
      // the selected speed is recognized by the runtime as well as the picker.
      const tier = ctx.thread.serviceTier;
      // 上下文: the task's own choice is Codex's `model_context_window`, over
      // whatever the provider's model row said.
      const window = ctx.thread.contextWindow;
      const codexConfig =
        route?.codexConfig != null || tier != null || window != null || cuaBinary != null
          ? {
              ...route?.codexConfig,
              ...(window != null ? { model_context_window: window } : {}),
              ...(tier != null ? { service_tier: tier } : {}),
              ...(cuaBinary != null ? { mcp_servers: { "cua-driver": { command: cuaBinary, args: ["mcp"], enabled_tools: [...CUA_TOOLS] } } } : {}),
            }
          : undefined;
      return createNativeCodexRunner(ctx, {
        ...(model != null ? { model } : {}),
        ...(route != null ? { auth: route.auth } : {}),
        ...(codexHome != null ? { codexHome } : {}),
        ...(codexConfig != null ? { codexConfig } : {}),
        ...(reasoningEffort != null ? { effort: reasoningEffort } : {}),
        ...(tier != null ? { serviceTier: tier } : {}),
      });
    },
  };
}
