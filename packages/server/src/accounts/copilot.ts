import { COPILOT_API, createCopilotModel, type CopilotProtocol } from "@vgent/providers";
import type { ModelEntry } from "../models.js";
import { reasoningFor } from "../reasoning.js";
import type { EngineId } from "../types.js";
import { accountJson, object, UsageError } from "./usage.js";

export interface GitHubAccess { accessToken: string; accountId: string; revision: number }

/** What a task's model is called when Copilot runs it: `github-copilot:<id>`, an account prefix in front for any but the first. */
export const COPILOT_SPEC_PREFIX = "github-copilot:";

/** One model of an account's Copilot, as its own list describes it. */
export interface CopilotModel {
  id: string;
  name: string;
  /** Who made it, as a provider-catalog id (`anthropic`, `openai`, …); absent for one we have no id for. */
  vendor?: string;
  /** The request shapes Copilot serves it on. Which engines can run it follows from these alone. */
  protocols: CopilotProtocol[];
  /** The effort levels it takes, in Copilot's order; empty when it takes none. */
  reasoningLevels: string[];
  /** What one request may carry: Copilot's prompt limit, not its context window, which counts the reply as well. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

const PROTOCOL_OF: Record<string, CopilotProtocol> = { "/chat/completions": "chat-completions", "/responses": "responses", "/v1/messages": "messages" };

/** Copilot's `vendor` names as provider-catalog ids; one not here gets none, and with it no default engine. */
const VENDOR_OF: Record<string, string> = { anthropic: "anthropic", openai: "openai", "azure openai": "openai", google: "google", xai: "xai", "moonshot ai": "moonshotai", microsoft: "microsoft" };

/**
 * The protocols each engine speaks, the one it prefers first. A model is an
 * engine's when Copilot serves it on one of them: Claude Code speaks only
 * Anthropic's Messages, Codex only Responses, and the two built on the AI SDK
 * all three — Messages first, where Claude's thinking and caching live.
 */
const ENGINE_PROTOCOLS: Record<EngineId, readonly CopilotProtocol[]> = {
  vgent: ["messages", "responses", "chat-completions"],
  opencode: ["messages", "responses", "chat-completions"],
  codex: ["responses"],
  "claude-code": ["messages"],
};

/** The protocol `engine` runs `model` on, or none when it cannot. */
export const copilotProtocol = (model: CopilotModel, engine: EngineId): CopilotProtocol | undefined =>
  ENGINE_PROTOCOLS[engine].find((protocol) => model.protocols.includes(protocol));

/** A model as `engine`'s list offers it, or nothing when that engine cannot run it. Without the account: see `AccountService.copilotModels`. */
export function copilotEntry(model: CopilotModel, engine: EngineId): ModelEntry | undefined {
  if (copilotProtocol(model, engine) == null) return undefined;
  return {
    id: `${COPILOT_SPEC_PREFIX}${model.id}`,
    label: model.name,
    modelKey: `github-copilot/${model.id}`,
    source: { kind: "provider", id: "github-copilot", name: "GitHub Copilot", logo: "github-copilot" },
    ...(model.vendor != null ? { vendor: model.vendor } : {}),
    ...reasoningFor(engine, model.reasoningLevels),
    ...(model.contextWindow != null ? { contextWindow: model.contextWindow } : {}),
  };
}

/** One entry of Copilot's `/models`, or nothing for one no engine could run as an agent. */
function readModel(raw: unknown): CopilotModel | undefined {
  const m = object(raw), caps = object(m.capabilities), limits = object(caps.limits), support = object(caps.supports);
  if (typeof m.id !== "string" || caps.type !== "chat" || support.tool_calls !== true || m.model_picker_enabled === false || object(m.policy).state === "disabled") return undefined;
  // An entry that names no endpoints predates them, when chat completions was all there was.
  const endpoints = Array.isArray(m.supported_endpoints) ? m.supported_endpoints : ["/chat/completions"];
  const protocols = [...new Set(endpoints.flatMap((endpoint) => (typeof endpoint === "string" && PROTOCOL_OF[endpoint] != null ? [PROTOCOL_OF[endpoint]] : [])))];
  if (protocols.length === 0) return undefined;
  const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined);
  const context = count(limits.max_context_window_tokens), output = count(limits.max_output_tokens);
  const prompt = count(limits.max_prompt_tokens) ?? (context != null && output != null && output < context ? context - output : context);
  const vendor = typeof m.vendor === "string" ? VENDOR_OF[m.vendor.toLowerCase()] : undefined;
  return {
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    ...(vendor != null ? { vendor } : {}),
    protocols,
    reasoningLevels: Array.isArray(support.reasoning_effort) ? support.reasoning_effort.filter((level): level is string => typeof level === "string") : [],
    ...(prompt != null ? { contextWindow: prompt } : {}),
    ...(output != null ? { maxOutputTokens: output } : {}),
  };
}

/**
 * Who a request is for Copilot: the user's own turn, or the agent going on with
 * one (a tool result going back). Chat completions and Responses send a tool
 * result as an item of its own; Messages puts it in a user message.
 */
function initiatorOf(body: Record<string, unknown>): "user" | "agent" {
  const items = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  if (items.length === 0) return "user";
  const last = object(items.at(-1));
  if (last.role !== "user") return "agent";
  return Array.isArray(last.content) && last.content.some((block) => object(block).type === "tool_result") ? "agent" : "user";
}

/** Effort levels from least to most, the way every protocol here spells them. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const rankOf = (level: string) => EFFORT_ORDER.indexOf(level);

/** The level Copilot takes for `wanted`: the most the model offers up to it, else the least it offers; none when it offers none. */
export function fitLevel(wanted: string, offered: readonly string[]): string | undefined {
  if (offered.includes(wanted)) return wanted;
  const sorted = offered.filter((level) => rankOf(level) >= 0).sort((a, b) => rankOf(a) - rankOf(b));
  return sorted.filter((level) => rankOf(level) <= rankOf(wanted)).at(-1) ?? sorted[0];
}

/**
 * A request's effort, made one the model takes. Copilot refuses a level its
 * list does not give the model, and any level at all for one that has none —
 * and the clients do not know: Claude Code sends 高 to a model it has never
 * heard of, Codex sends whatever the task chose. Changed in place; true when
 * something was.
 */
function fitEffort(body: Record<string, unknown>, offered: readonly string[]): boolean {
  // Messages: `output_config.effort`; Responses: `reasoning.effort`; chat completions: `reasoning_effort`.
  const holders: Array<[Record<string, unknown>, string]> = [[object(body.output_config), "effort"], [object(body.reasoning), "effort"], [body, "reasoning_effort"]];
  let changed = false;
  for (const [holder, field] of holders) {
    const wanted = holder[field];
    if (typeof wanted !== "string") continue;
    const level = fitLevel(wanted, offered);
    if (level === wanted) continue;
    if (level == null) delete holder[field];
    else holder[field] = level;
    changed = true;
  }
  return changed;
}

/** The account's own API host, from its token; anything that is not Copilot's keeps the shared one. */
function apiOf(data: Record<string, unknown>): string {
  try {
    const url = new URL(String(object(data.endpoints).api));
    return url.protocol === "https:" && url.hostname.endsWith(".githubcopilot.com") ? url.origin : COPILOT_API;
  } catch { return COPILOT_API; }
}

export type CopilotAccess = ReturnType<typeof createCopilotAccess>;

export function createCopilotAccess(access: () => Promise<GitHubAccess>, fetcher = fetch) {
  let cached: { key: string; expires: number; token: string; api: string } | undefined;
  let pending: { key: string; promise: Promise<{ token: string; api: string }> } | undefined;
  let catalog: { key: string; at: number; models: CopilotModel[] } | undefined;
  let catalogPending: { key: string; promise: Promise<CopilotModel[]> } | undefined;
  const keyOf = (a: GitHubAccess) => `${a.accountId}:${a.revision}:${a.accessToken}`;
  const headers = { "User-Agent": "Vgent", "Editor-Version": "vscode/1.99.0", "Editor-Plugin-Version": "copilot/1.300.0", "Copilot-Integration-Id": "vscode-chat" };
  const session = async () => {
    const original = await access(), key = keyOf(original);
    if (cached?.key === key && cached.expires > Date.now() + 60_000) return cached;
    if (pending?.key === key) return pending.promise;
    const promise = (async () => {
      const data = object(await accountJson("https://api.github.com/copilot_internal/v2/token", { ...headers, Authorization: `Bearer ${original.accessToken}` }, fetcher));
      if (keyOf(await access()) !== key) throw new Error("GitHub account changed");
      if (typeof data.token !== "string" || typeof data.expires_at !== "number") throw new Error("Copilot access unavailable");
      cached = { key, token: data.token, expires: data.expires_at * 1000, api: apiOf(data) };
      return cached;
    })();
    pending = { key, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
  };
  /** Takes `COPILOT_API` addresses, as every client of this access is given, and sends them to the account's host. */
  const modelFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.origin !== COPILOT_API) throw new Error("Unexpected Copilot endpoint");
    const { token, api } = await session();
    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => requestHeaders.set(k, v));
    for (const [k, v] of Object.entries(headers)) requestHeaders.set(k, v);
    // The SDKs' and the relay's placeholder credentials stay here.
    requestHeaders.delete("x-api-key");
    requestHeaders.set("Authorization", `Bearer ${token}`);
    requestHeaders.set("Openai-Intent", "conversation-edits");
    let initiator: "user" | "agent" = "user";
    let body = init?.body;
    if (typeof body === "string") {
      let parsed: Record<string, unknown> | undefined;
      try { parsed = object(JSON.parse(body)); } catch { /* The SDK validates the request body. */ }
      if (parsed != null) {
        initiator = initiatorOf(parsed);
        const model = typeof parsed.model === "string" ? (await result.models()).find((entry) => entry.id === parsed.model) : undefined;
        if (model != null && fitEffort(parsed, model.reasoningLevels)) body = JSON.stringify(parsed);
      }
    }
    requestHeaders.set("X-Initiator", initiator);
    const response = await fetcher(`${api}${url.pathname}${url.search}`, { ...init, ...(body != null ? { body } : {}), headers: requestHeaders, redirect: "error" });
    if ([401, 403].includes(response.status)) cached = undefined;
    return response;
  };
  const result = {
    invalidate() { cached = undefined; catalog = undefined; catalogPending = undefined; },
    async available() { await session(); },
    /** A request to Copilot on this account's credentials, for the relay. */
    fetch: modelFetch,
    /** The model as this account's list has it; undefined when the list does not. */
    async find(id: string): Promise<CopilotModel | undefined> {
      return (await result.models()).find((model) => model.id === id);
    },
    /** The in-house engine's model: the AI SDK client for the protocol it prefers. */
    async model(id: string) {
      const model = await result.find(id);
      const protocol = model != null ? copilotProtocol(model, "vgent") : undefined;
      if (model == null || protocol == null) throw new Error("Copilot model unavailable for this GitHub account");
      return createCopilotModel(id, modelFetch, protocol, { reasoning: model.reasoningLevels.length > 0 });
    },
    async models(refresh = false): Promise<CopilotModel[]> {
      const original = await access(), key = keyOf(original);
      if (!refresh && catalog?.key === key && Date.now() - catalog.at < 60_000) return catalog.models;
      if (catalogPending?.key === key) return catalogPending.promise;
      const promise = (async () => {
        const response = await modelFetch(`${COPILOT_API}/models`, { signal: AbortSignal.timeout(12_000) });
        if (!response.ok) throw new UsageError(response.status);
        const data = object(await response.json());
        if (keyOf(await access()) !== key) throw new Error("GitHub account changed");
        const models = (Array.isArray(data.data) ? data.data : []).flatMap((raw) => readModel(raw) ?? []);
        catalog = { key, at: Date.now(), models };
        return models;
      })();
      catalogPending = { key, promise };
      try { return await promise; } finally { if (catalogPending?.promise === promise) catalogPending = undefined; }
    },
  };
  return result;
}
