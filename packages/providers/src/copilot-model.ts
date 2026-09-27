import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** Request-time credentials are supplied by the backend's one GitHub account owner. */
export function createCopilotModel(model: string, fetch: typeof globalThis.fetch): LanguageModel {
  return createOpenAICompatible({ name: "github-copilot", baseURL: "https://api.githubcopilot.com", apiKey: "injected-per-request", fetch, includeUsage: true }).chatModel(model);
}
