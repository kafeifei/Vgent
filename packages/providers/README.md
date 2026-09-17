# @vgent/providers

AI SDK `LanguageModel` factories. Everything outside this package only ever sees a `LanguageModel`.

- `createApiKeyModel('openai/gpt-5.5')` — **the default and the compliant path.** Resolves `provider/model` through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), or point the gateway at your own provider API keys.
- `createCodexSubscriptionModel(modelId)` — **opt-in only.** Uses the ChatGPT subscription credential that `codex login` stores in `~/.codex/auth.json` (or the OS keyring) to call `https://chatgpt.com/backend-api/codex`. This is **outside OpenAI's officially supported surface**: the endpoint, headers and request shape are undocumented, may break without notice, and using them may put the ChatGPT account at risk. Nothing selects it for you.
- `describeSubscriptionAuth()` — reports whether a subscription login exists, where it lives, and when it expires. Never returns or logs the token.

Claude is **not** available as a subscription model here — use the Claude Code harness engine (`@vgent/engines`), which runs the official CLI with its own login.

Tokens are only ever read from, and refreshed back into, the store that owns them. To switch away from the subscription path, just build the model with `createApiKeyModel` instead; no other code changes.

Live smoke tests are skipped unless `VGENT_SMOKE=1` (they need a real login and spend quota): `VGENT_SMOKE=1 pnpm --filter @vgent/providers test`.
