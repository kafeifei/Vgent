import { createCopilotModel } from "@vgent/providers";
import type { ModelEntry } from "../models.js";
import { accountJson, object, UsageError } from "./usage.js";

export interface GitHubAccess { accessToken: string; accountId: string; revision: number }
export function createCopilotAccess(access: () => Promise<GitHubAccess>, fetcher = fetch) {
  let cached: { key: string; expires: number; token: string } | undefined;
  let pending: { key: string; promise: Promise<string> } | undefined;
  let catalog: { key: string; at: number; models: ModelEntry[] } | undefined;
  const keyOf = (a: GitHubAccess) => `${a.accountId}:${a.revision}:${a.accessToken}`;
  const headers = { "User-Agent": "Vgent", "Editor-Version": "vscode/1.99.0", "Editor-Plugin-Version": "copilot/1.300.0", "Copilot-Integration-Id": "vscode-chat" };
  const token = async () => {
    const original = await access(), key = keyOf(original);
    if (cached?.key === key && cached.expires > Date.now() + 60_000) return cached.token;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      const data = object(await accountJson("https://api.github.com/copilot_internal/v2/token", { ...headers, Authorization: `Bearer ${original.accessToken}` }, fetcher));
      if (keyOf(await access()) !== key) throw new Error("GitHub account changed");
      if (typeof data.token !== "string" || typeof data.expires_at !== "number") throw new Error("Copilot access unavailable");
      cached = { key, token: data.token, expires: data.expires_at * 1000 };
      return data.token;
    })();
    pending = { key, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
  };
  const modelFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.origin !== "https://api.githubcopilot.com") throw new Error("Unexpected Copilot endpoint");
    const auth = await token();
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => requestHeaders.set(k, v));
    for (const [k, v] of Object.entries(headers)) requestHeaders.set(k, v);
    requestHeaders.set("Authorization", `Bearer ${auth}`);
    requestHeaders.set("Openai-Intent", "conversation-edits");
    let initiator = "user";
    try {
      const body = typeof init?.body === "string" ? object(JSON.parse(init.body)) : {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (messages.length && object(messages.at(-1)).role !== "user") initiator = "agent";
    } catch { /* The SDK validates the request body. */ }
    requestHeaders.set("X-Initiator", initiator);
    const response = await fetcher(input, { ...init, headers: requestHeaders, redirect: "error" });
    if ([401, 403].includes(response.status)) cached = undefined;
    return response;
  };
  return {
    invalidate() { cached = undefined; catalog = undefined; },
    async available() { await token(); },
    model(id: string) { return createCopilotModel(id, modelFetch); },
    async models(refresh = false): Promise<ModelEntry[]> {
      const original = await access(), key = keyOf(original);
      if (!refresh && catalog?.key === key && Date.now() - catalog.at < 60_000) return catalog.models;
      const response = await modelFetch("https://api.githubcopilot.com/models", { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new UsageError(response.status);
      const data = object(await response.json());
      if (keyOf(await access()) !== key) throw new Error("GitHub account changed");
      const models: ModelEntry[] = (Array.isArray(data.data) ? data.data : []).flatMap(raw => {
        const m = object(raw), caps = object(m.capabilities), limits = object(caps.limits), support = object(caps.supports);
        if (typeof m.id !== "string" || caps.type !== "chat" || support.tool_calls !== true || m.model_picker_enabled === false || object(m.policy).state === "disabled") return [];
        // Only advertise a protocol this adapter can execute with tools.
        if (Array.isArray(m.supported_endpoints) && !m.supported_endpoints.includes("/chat/completions")) return [];
        return [{ id: `github-copilot:${m.id}`, label: typeof m.name === "string" ? m.name : m.id, modelKey: `github-copilot/${m.id}`, source: { kind: "provider", id: "github-copilot", name: "GitHub Copilot", logo: "github-copilot" }, ...(typeof limits.max_context_window_tokens === "number" ? { contextWindow: limits.max_context_window_tokens } : {}) }];
      });
      catalog = { key, at: Date.now(), models };
      return models;
    },
  };
}
