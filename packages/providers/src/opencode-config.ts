import { ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS, anthropicSdkBaseURL, bedrockRegionOf, isAnthropicFirstParty } from "./model-registry.js";
import { SDK_KINDS, type ProviderConfig } from "./provider-config.js";

/**
 * The OpenCode provider id a settings-page provider runs under. Namespaced, so
 * it is always a provider of its own and never merges into one OpenCode already
 * knows (a provider the user named `openai` must not take over OpenCode's).
 */
export const openCodeProviderId = (providerId: string): string => `vgent-${providerId}`;

/** What a turn knows about the one model it runs, beyond what the provider stores. */
export interface OpenCodeModelFacts {
  /** The model reasons: OpenCode then derives its variants (low / high / …) from the package and the id. */
  reasoning?: boolean;
  /** The window to compact within; unknown leaves OpenCode's own `0`, which never compacts early. */
  contextWindow?: number;
}

/**
 * A settings-page provider as an entry of OpenCode's `provider` config — the
 * same AI SDK package, address and credential `sdkProviderFor` gives the
 * in-house engine, spelled the way OpenCode takes them (`npm` + `options`,
 * handed to the package's `create*` as they are).
 *
 * Only the `opencode` agent's endpoint is used, and only its ticked models are
 * listed. `facts` adds what the stored list does not say about a model.
 */
export function openCodeProviderConfig(
  provider: ProviderConfig,
  facts: Readonly<Record<string, OpenCodeModelFacts>> = {},
): Record<string, unknown> | undefined {
  const agent = provider.agents.opencode;
  if (agent == null) return undefined;
  const apiKey = provider.apiKey != null && provider.apiKey !== "" ? provider.apiKey : undefined;
  const thirdPartyAnthropic = agent.protocol === "anthropic" && !isAnthropicFirstParty(agent.baseURL);

  let options: Record<string, unknown>;
  switch (agent.protocol) {
    case "anthropic":
      options = {
        baseURL: anthropicSdkBaseURL(agent.baseURL),
        ...(apiKey == null ? {} : thirdPartyAnthropic ? { authToken: apiKey } : { apiKey }),
      };
      break;
    case "openai-compatible":
      // Without it a streamed turn reports no token usage.
      options = { baseURL: agent.baseURL, ...(apiKey != null ? { apiKey } : {}), includeUsage: true };
      break;
    case "amazon-bedrock": {
      const region = bedrockRegionOf(agent.baseURL);
      options = { baseURL: agent.baseURL, ...(apiKey != null ? { apiKey } : {}), ...(region != null ? { region } : {}) };
      break;
    }
    default:
      options = { baseURL: agent.baseURL, ...(apiKey != null ? { apiKey } : {}) };
  }

  const ids = new Set([...agent.models.map((model) => model.id), ...Object.keys(facts)]);
  const models: Record<string, unknown> = {};
  for (const id of ids) {
    const stored = agent.models.find((model) => model.id === id);
    const known = facts[id];
    const context = known?.contextWindow ?? stored?.contextWindow;
    // `@ai-sdk/anthropic` caps an id it does not know at 4096 output tokens; see `ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS`.
    const output = thirdPartyAnthropic ? ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS : undefined;
    models[id] = {
      name: stored?.label ?? id,
      ...(known?.reasoning === true ? { reasoning: true } : {}),
      // Both or neither: OpenCode's own `0` means unknown.
      ...(context != null || output != null ? { limit: { context: context ?? 0, output: output ?? 0 } } : {}),
    };
  }

  return { npm: SDK_KINDS[agent.protocol].npm, name: provider.name, options, models };
}
