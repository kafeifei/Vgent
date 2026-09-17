import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { CodexCredentialOptions } from "./codex-credentials.js";
import { CHATGPT_CODEX_BASE_URL, CodexTokenProvider } from "./codex-credentials.js";
import { createCodexFetch } from "./codex-fetch.js";

/**
 * The provider requires *some* api key to construct; the real credential is
 * injected per request by the custom fetch and this value is never sent.
 */
const UNUSED_API_KEY = "unused-oauth-is-injected-per-request";

export type CodexSubscriptionModelOptions = CodexCredentialOptions & {
  /** Override the ChatGPT Codex endpoint (tests only). */
  readonly baseURL?: string;
  /** Extra headers merged into every request. */
  readonly headers?: Record<string, string>;
  /** Client identifier header. Defaults to what the Codex CLI sends. */
  readonly originator?: string;
  /** Underlying fetch, for tests. */
  readonly fetch?: typeof globalThis.fetch;
};

/**
 * A `LanguageModel` backed by the machine's ChatGPT (Codex CLI) subscription
 * login instead of an API key.
 *
 * Opt-in only. This is outside OpenAI's officially supported surface: the
 * endpoint, headers and request shape can change without notice, and using it
 * carries account risk. Prefer {@link createApiKeyModel}.
 */
export function createCodexSubscriptionModel(
  modelId: string,
  options: CodexSubscriptionModelOptions = {},
): LanguageModel {
  const tokens = new CodexTokenProvider(options);
  const provider = createOpenAI({
    name: "codex-subscription",
    apiKey: UNUSED_API_KEY,
    baseURL: options.baseURL ?? CHATGPT_CODEX_BASE_URL,
    ...(options.headers == null ? {} : { headers: options.headers }),
    fetch: createCodexFetch({
      tokens,
      ...(options.fetch == null ? {} : { fetch: options.fetch }),
      ...(options.originator == null ? {} : { originator: options.originator }),
      ...(options.baseURL == null ? {} : { baseURL: options.baseURL }),
    }),
  });
  return provider.responses(modelId);
}
