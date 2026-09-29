import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "./provider-config.js";

// GPT-5.4 is documented by the SDK; GPT-5.5 and GPT-6-astra were verified live.
// Unknown models conservatively keep generic search, without future/suffix inference.
const HOSTED_TOOL_SEARCH_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-6-astra"];

/** Provider names alone do not establish that a Responses endpoint is official. */
export function createOpenAIToolSearch(model: LanguageModel | undefined, providers: readonly ProviderConfig[] = []): ReturnType<typeof openai.tools.toolSearch> | undefined {
  if (model == null || typeof model === "string") return undefined;
  if (!HOSTED_TOOL_SEARCH_MODELS.includes(model.modelId)) return undefined;
  if (model.provider !== "codex-subscription.responses") {
    const config = providers.find((provider) => `${provider.id}.responses` === model.provider)?.agents.vgent;
    if (config?.protocol !== "openai") return undefined;
    try {
      const url = new URL(config.baseURL);
      if (url.origin !== "https://api.openai.com" || url.pathname.replace(/\/+$/, "") !== "/v1"
        || url.username || url.password || url.search || url.hash) return undefined;
    } catch {
      return undefined;
    }
  }
  return openai.tools.toolSearch();
}
