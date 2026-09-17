import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
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
  // `store: false` is not a preference, it is what this endpoint does — the
  // request rewrite in `createCodexFetch` forces it on the wire. The provider
  // has to agree, because it decides how to replay earlier assistant turns
  // *before* that rewrite runs: left at its default (`store: true`) it replays
  // a reasoning item as `{ type: 'item_reference', id: 'rs_…' }`, and the
  // endpoint rejects the whole request with "Items are not persisted when
  // `store` is set to false". Told the truth, it inlines the reasoning with its
  // `encrypted_content` instead, which is what survives a round trip through
  // stored UI messages — so a paused turn can still be continued later, even in
  // another process.
  return wrapLanguageModel({
    model: provider.responses(modelId),
    middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
  });
}
