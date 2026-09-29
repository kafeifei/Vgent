import type { LanguageModel, ToolLoopAgentSettings } from "ai";
import type { ProviderConfig } from "@vgent/providers";

/** Use the SDK's cache key, as OpenCode does; Codex also needs backend session affinity. */
export function promptCaching(
  model: LanguageModel,
  sessionId: string,
  providers: readonly ProviderConfig[] = [],
): Pick<ToolLoopAgentSettings, "providerOptions" | "headers" | "allowSystemInMessages"> {
  if (typeof model === "string") return {};
  const codex = model.provider === "codex-subscription.responses";
  const responses = codex || model.provider === "openai.responses" || providers.some(
    (provider) => provider.agents.vgent?.protocol === "openai" && model.provider === `${provider.id}.responses`,
  );
  const openai = responses || model.provider === "openai.chat" || (model.provider.startsWith("gateway") && model.modelId.startsWith("openai/"));
  return {
    ...(openai ? { providerOptions: { openai: { promptCacheKey: sessionId } } } : {}),
    ...(codex ? { headers: { "session-id": sessionId } } : {}),
    // Other protocols (notably Gemini / Bedrock) can reject mid-conversation system messages.
    ...(responses ? { allowSystemInMessages: true } : {}),
  };
}
