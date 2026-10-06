import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS } from "./model-registry.js";

/**
 * The three request shapes Copilot serves, as its model list names them in
 * `supported_endpoints`: `/chat/completions`, `/responses`, `/v1/messages`.
 */
export type CopilotProtocol = "chat-completions" | "responses" | "messages";

/**
 * Where the SDK clients send Copilot requests. The account's real API host
 * (`api.individual.githubcopilot.com`, a business one…) comes with its token,
 * so the fetch these models are given moves each request there.
 */
export const COPILOT_API = "https://api.githubcopilot.com";

/**
 * For a model Copilot lists no effort levels for: the call asks for no
 * reasoning at all. Left in, `@ai-sdk/anthropic` turns it into adaptive
 * thinking, which such a model refuses.
 */
const WITHOUT_REASONING: LanguageModelMiddleware = {
  transformParams: async ({ params: { reasoning: _reasoning, ...params } }) => params,
};

/**
 * All three protocols use request-time credentials from the one GitHub owner,
 * which `fetch` adds — along with the account's API host, and an effort level
 * the model takes.
 */
export function createCopilotModel(
  model: string,
  fetch: typeof globalThis.fetch,
  protocol: CopilotProtocol = "chat-completions",
  options: { reasoning?: boolean } = {},
): LanguageModel {
  const base = copilotClient(model, fetch, protocol);
  return options.reasoning === false ? wrapLanguageModel({ model: base, middleware: WITHOUT_REASONING }) : base;
}

function copilotClient(model: string, fetch: typeof globalThis.fetch, protocol: CopilotProtocol): Exclude<LanguageModel, string> {
  const common = { baseURL: COPILOT_API, fetch };
  if (protocol === "messages") {
    return wrapLanguageModel({
      model: createAnthropic({ name: "github-copilot", ...common, baseURL: `${COPILOT_API}/v1`, authToken: "injected-per-request" })(model),
      // Like any Anthropic-compatible endpoint: the package would cap an id it does not know at 4096.
      middleware: defaultSettingsMiddleware({ settings: { maxOutputTokens: ANTHROPIC_COMPATIBLE_MAX_OUTPUT_TOKENS } }),
    });
  }
  if (protocol === "responses") {
    return wrapLanguageModel({
      model: createOpenAI({ name: "github-copilot", ...common, apiKey: "injected-per-request" }).responses(model),
      middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
    });
  }
  return createOpenAICompatible({ name: "github-copilot", ...common, apiKey: "injected-per-request", includeUsage: true }).chatModel(model);
}
