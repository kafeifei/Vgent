import { gateway } from "ai";
import type { LanguageModel } from "ai";

/**
 * The compliant default path: resolve a `provider/model` string through the
 * Vercel AI Gateway, which authenticates with `AI_GATEWAY_API_KEY` (or an OIDC
 * token on Vercel) and forwards to the provider.
 */
export function createApiKeyModel(spec: string): LanguageModel {
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1 || spec.includes(" ")) {
    throw new Error(`Invalid model spec ${JSON.stringify(spec)}; expected "provider/model".`);
  }
  return gateway(spec);
}
