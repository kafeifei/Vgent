import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createProviderRegistry, customProvider, defaultSettingsMiddleware, gateway, wrapProvider } from "ai";
import type { LanguageModel } from "ai";
import { createApiKeyModel } from "./api-key-model.js";
import type { CodexSubscriptionModelOptions } from "./codex-model.js";
import { createCodexSubscriptionModel } from "./codex-model.js";
import { PROVIDER_MODEL_SEPARATOR, splitProviderModelSpec, type ProviderAgentConfig, type ProviderConfig } from "./provider-config.js";

/** The registry id of the machine's ChatGPT / Codex login. `codex-subscription:gpt-5.5` has always been spelled this way. */
export const CODEX_SUBSCRIPTION_PROVIDER_ID = "codex-subscription";
/** The registry id of the Vercel AI Gateway, for the explicit `gateway:provider/model` spelling. */
export const GATEWAY_PROVIDER_ID = "gateway";

/** What a model spec routes to, worked out without constructing anything. */
export type ModelSpecKind =
  | { kind: "codex-subscription"; modelId: string }
  | { kind: "gateway"; modelId: string }
  | { kind: "provider"; provider: ProviderConfig; modelId: string }
  | { kind: "invalid"; reason: string };

type RegistryProvider = Parameters<typeof createProviderRegistry>[0][string];

/** A gateway spec is `creator/model`: one slash at least, no whitespace, nothing empty around the first slash. */
function isGatewaySpec(spec: string): boolean {
  const slash = spec.indexOf("/");
  return slash > 0 && slash < spec.length - 1 && !/\s/.test(spec);
}

/**
 * Classifies a thread's model string. The single place that knows the three
 * spellings, so a precondition check and the registry can never disagree:
 *
 * - `codex-subscription:<id>` — the machine's ChatGPT / Codex login
 * - `<providerId>:<id>` — a provider from the settings page, as the in-house agent reaches it
 * - `creator/model` (or `gateway:creator/model`) — the Vercel AI Gateway
 */
export function describeModelSpec(spec: string, providers: readonly ProviderConfig[] = []): ModelSpecKind {
  const split = splitProviderModelSpec(spec);
  if (split != null) {
    if (split.providerId === CODEX_SUBSCRIPTION_PROVIDER_ID) return { kind: "codex-subscription", modelId: split.modelId };
    if (split.providerId === GATEWAY_PROVIDER_ID) {
      return isGatewaySpec(split.modelId)
        ? { kind: "gateway", modelId: split.modelId }
        : { kind: "invalid", reason: `${GATEWAY_PROVIDER_ID}: 后面应为 "creator/model"` };
    }
    const provider = providers.find((entry) => entry.id === split.providerId);
    if (provider != null) {
      return provider.agents.vgent != null
        ? { kind: "provider", provider, modelId: split.modelId }
        : { kind: "invalid", reason: `提供商「${provider.name}」没有给自研引擎配置接入地址` };
    }
  }
  if (spec.startsWith(`${CODEX_SUBSCRIPTION_PROVIDER_ID}${PROVIDER_MODEL_SEPARATOR}`)) {
    return { kind: "invalid", reason: `${CODEX_SUBSCRIPTION_PROVIDER_ID}: 后面缺少模型 id` };
  }
  if (isGatewaySpec(spec)) return { kind: "gateway", modelId: spec };
  if (split != null) return { kind: "invalid", reason: `没有叫 ${JSON.stringify(split.providerId)} 的提供商，可能已被删除` };
  return { kind: "invalid", reason: '应为 "<提供商>:<模型>"、"codex-subscription:<模型>" 或 "creator/model"' };
}

/**
 * The AI SDK base URL of an Anthropic-compatible endpoint. A provider's
 * `baseURL` is stored the way the `claude` CLI wants it (`ANTHROPIC_BASE_URL`,
 * which has `/v1/messages` appended), while `createAnthropic` wants the `/v1`
 * included — so it is added here unless it is already there.
 */
export function anthropicSdkBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Anthropic's own API takes `x-api-key`; the compatible endpoints document the Bearer form, which is what the `claude` CLI sends them too. */
function isAnthropicFirstParty(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * `@ai-sdk/anthropic` caps the output of a model id it does not know at 4096
 * tokens unless the call says otherwise — and every model behind a compatible
 * endpoint is one it does not know. Far too small for an agent that writes
 * files, so the provider is wrapped with an explicit default. A call that sets
 * its own `maxOutputTokens` still wins.
 */
const ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS = 16_000;

function sdkProviderFor(providerId: string, agent: ProviderAgentConfig, apiKey: string | undefined, fetch: typeof globalThis.fetch | undefined) {
  if (agent.protocol === "anthropic") {
    const credential = apiKey == null || apiKey === "" ? {} : isAnthropicFirstParty(agent.baseURL) ? { apiKey } : { authToken: apiKey };
    const anthropic = createAnthropic({
      name: providerId,
      baseURL: anthropicSdkBaseURL(agent.baseURL),
      ...credential,
      ...(fetch == null ? {} : { fetch }),
    });
    if (isAnthropicFirstParty(agent.baseURL)) return anthropic;
    return wrapProvider({
      provider: anthropic,
      languageModelMiddleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS } }),
    });
  }
  return createOpenAICompatible({
    name: providerId,
    baseURL: agent.baseURL,
    ...(apiKey == null || apiKey === "" ? {} : { apiKey }),
    // Without it a streamed turn reports no token usage, and the context ring has nothing to show.
    includeUsage: true,
    ...(fetch == null ? {} : { fetch }),
  });
}

export interface ModelRegistryOptions {
  /** The providers from the settings page. Only those with a `vgent` agent are registered. */
  providers?: readonly ProviderConfig[];
  /** Passed to every `codex-subscription:*` model; tests point it at a fake login. */
  codex?: CodexSubscriptionModelOptions;
  /** Underlying fetch of the configured providers, for tests. */
  fetch?: typeof globalThis.fetch;
}

export interface ModelRegistry {
  /** The model a thread's `model` string names. Throws with a message fit to show the user. */
  languageModel(spec: string): LanguageModel;
  describe(spec: string): ModelSpecKind;
}

/**
 * Every model source of the in-house agent behind one string id, built on the
 * AI SDK's provider management: a `createProviderRegistry` holding the gateway
 * and one `customProvider` per configured provider. Each lists the models the
 * user ticked and falls back to the provider itself, so a model the page has
 * not listed yet still resolves.
 */
export function createModelRegistry(options: ModelRegistryOptions = {}): ModelRegistry {
  const providers = options.providers ?? [];

  // The Codex login is not an SDK provider object — it is one wrapped model per
  // id — so it is resolved directly below; everything else goes through the registry.
  const entries: Record<string, RegistryProvider> = { [GATEWAY_PROVIDER_ID]: gateway };

  for (const provider of providers) {
    const agent = provider.agents.vgent;
    if (agent == null) continue;
    const base = sdkProviderFor(provider.id, agent, provider.apiKey, options.fetch);
    entries[provider.id] = customProvider({
      languageModels: Object.fromEntries(agent.models.map((model) => [model.id, base.languageModel(model.id)])),
      fallbackProvider: base,
    });
  }

  const registry = createProviderRegistry(entries, { separator: PROVIDER_MODEL_SEPARATOR });

  const describe = (spec: string) => describeModelSpec(spec, providers);

  return {
    describe,
    languageModel(spec) {
      const described = describe(spec);
      switch (described.kind) {
        case "invalid":
          throw new Error(`模型标识不合法: ${JSON.stringify(spec)}，${described.reason}`);
        case "gateway":
          return createApiKeyModel(described.modelId);
        case "codex-subscription":
          return createCodexSubscriptionModel(described.modelId, options.codex);
        case "provider":
          return registry.languageModel(`${described.provider.id}${PROVIDER_MODEL_SEPARATOR}${described.modelId}`);
      }
    },
  };
}
