import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";

/** Both Copilot protocols use request-time credentials from the one GitHub owner. */
export function createCopilotModel(model: string, fetch: typeof globalThis.fetch, protocol: "chat-completions" | "responses" = "chat-completions"): LanguageModel {
  const options = { name: "github-copilot", baseURL: "https://api.githubcopilot.com", apiKey: "injected-per-request", fetch };
  if (protocol === "responses") return wrapLanguageModel({
    model: createOpenAI(options).responses(model),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
  return createOpenAICompatible({ ...options, includeUsage: true }).chatModel(model);
}
