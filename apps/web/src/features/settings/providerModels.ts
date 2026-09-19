import type { ProviderInputBody } from "@/lib/api";
import type { CatalogProvider, CatalogProviderSummary, ProviderAgent, ProviderModel, ProviderProtocol, RedactedProviderConfig, SubscriptionAccount, SubscriptionModel } from "@/lib/types";

/**
 * The logic behind 模型提供商 and 模型, kept out of the components so it can be
 * tested: what connecting a provider sends, what the model table lists, and
 * what flipping one of its switches sends.
 */

/** The agents, in the order the model table's columns stand. */
export const AGENT_ORDER: readonly ProviderAgent[] = ["vgent", "claude-code", "codex"];

function checkURL(value: string, what: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${what}要以 http:// 或 https:// 开头`;
  } catch {
    return `${what}不是合法的 URL`;
  }
  return undefined;
}

export interface ConnectForm {
  apiKey: string;
  /** Only asked for when the catalog has no address (an Azure resource, a self-hosted server). */
  baseURL: string;
}

/**
 * What connecting a catalog provider sends: every agent this build can serve
 * with it, at the catalog's address, and no model ticked yet — ticking is the
 * next step, on the model table.
 */
export function connectInput(
  entry: CatalogProviderSummary,
  usable: readonly ProviderAgent[],
  form: ConnectForm,
): { input: ProviderInputBody } | { error: string } {
  const apiKey = form.apiKey.trim();
  if (apiKey === "" && entry.keyless !== true) return { error: "填上 API key" };
  const typed = form.baseURL.trim().replace(/\/+$/, "");
  const agents: ProviderInputBody["agents"] = {};
  for (const agent of AGENT_ORDER) {
    const endpoint = entry.agents[agent];
    if (endpoint == null || !usable.includes(agent)) continue;
    const baseURL = endpoint.baseURL ?? typed;
    if (baseURL === "") return { error: "填上接入地址" };
    const problem = checkURL(baseURL, "接入地址");
    if (problem != null) return { error: problem };
    agents[agent] = { baseURL, protocol: endpoint.protocol, models: [] };
  }
  if (Object.keys(agents).length === 0) return { error: "这个提供商现在接不了" };
  return { input: { name: entry.name, presetId: entry.id, ...(apiKey !== "" ? { apiKey } : {}), agents } };
}

export interface CustomForm {
  name: string;
  protocol: Extract<ProviderProtocol, "openai-compatible" | "anthropic">;
  baseURL: string;
  /** An Anthropic-compatible address of the same service, for Claude Code. Optional; ignored when `protocol` is already Anthropic. */
  claudeBaseURL: string;
  /**
   * The service also answers OpenAI's Responses API at this address
   * (`<baseURL>/responses`) — the only protocol Codex speaks. Nobody can tell
   * from outside, so it is the user's word; ignored when `protocol` is Anthropic.
   */
  codexResponses: boolean;
  apiKey: string;
}

export const EMPTY_CUSTOM_FORM: CustomForm = { name: "", protocol: "openai-compatible", baseURL: "", claudeBaseURL: "", codexResponses: false, apiKey: "" };

/** A provider that is in no catalog: a company gateway, a self-hosted server. */
export function customInput(form: CustomForm, usable: readonly ProviderAgent[]): { input: ProviderInputBody } | { error: string } {
  const name = form.name.trim();
  if (name === "") return { error: "给提供商起个名字" };
  const baseURL = form.baseURL.trim().replace(/\/+$/, "");
  if (baseURL === "") return { error: "填上接入地址" };
  const problem = checkURL(baseURL, "接入地址");
  if (problem != null) return { error: problem };

  const agents: ProviderInputBody["agents"] = {};
  if (usable.includes("vgent")) agents.vgent = { baseURL, protocol: form.protocol, models: [] };
  if (usable.includes("claude-code")) {
    const claudeURL = form.protocol === "anthropic" ? baseURL : form.claudeBaseURL.trim().replace(/\/+$/, "");
    if (claudeURL !== "") {
      const claudeProblem = checkURL(claudeURL, "Claude Code 的接入地址");
      if (claudeProblem != null) return { error: claudeProblem };
      agents["claude-code"] = { baseURL: claudeURL, protocol: "anthropic", models: [] };
    }
  }
  if (usable.includes("codex") && form.protocol === "openai-compatible" && form.codexResponses) {
    agents.codex = { baseURL, protocol: "openai", models: [] };
  }
  if (Object.keys(agents).length === 0) return { error: "没有能用这个提供商的 agent" };
  const apiKey = form.apiKey.trim();
  return { input: { name, ...(apiKey !== "" ? { apiKey } : {}), agents } };
}

/** The agents a connected provider has an endpoint for, in column order. */
export function agentsOf(provider: RedactedProviderConfig): ProviderAgent[] {
  return AGENT_ORDER.filter((agent) => provider.agents[agent] != null);
}

/**
 * The rows of a provider's model table: what is ticked first (in the order the
 * picker shows it), then what the provider's own listing returned, then the
 * catalog's. One row per id; the first source to name a model also names its label.
 */
export function modelRows(
  provider: RedactedProviderConfig,
  catalog: Pick<CatalogProvider, "models"> | undefined,
  discovered: readonly ProviderModel[],
): ProviderModel[] {
  const rows = new Map<string, ProviderModel>();
  const add = (model: ProviderModel) => {
    const known = rows.get(model.id);
    if (known == null) rows.set(model.id, model);
    // A later source may still know what an earlier one did not.
    else rows.set(model.id, { ...model, ...known });
  };
  for (const agent of AGENT_ORDER) provider.agents[agent]?.models.forEach(add);
  discovered.forEach(add);
  catalog?.models.forEach(add);
  return [...rows.values()];
}

export function filterModels(rows: readonly ProviderModel[], query: string): ProviderModel[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...rows];
  return rows.filter((row) => row.id.toLowerCase().includes(needle) || (row.label ?? "").toLowerCase().includes(needle));
}

export function isEnabled(provider: RedactedProviderConfig, agent: ProviderAgent, modelId: string): boolean {
  return provider.agents[agent]?.models.some((model) => model.id === modelId) === true;
}

/**
 * The update that turns models on or off for one agent. Everything else about
 * the provider is sent back as it is, and the key is left out so the server
 * keeps the one it has.
 */
export function withModels(provider: RedactedProviderConfig, agent: ProviderAgent, models: readonly ProviderModel[], on: boolean): ProviderInputBody {
  const current = provider.agents[agent];
  const agents = { ...provider.agents };
  if (current != null) {
    const ids = new Set(models.map((model) => model.id));
    const next = on
      ? [...current.models, ...models.filter((model) => !current.models.some((entry) => entry.id === model.id))]
      : current.models.filter((model) => !ids.has(model.id));
    agents[agent] = { ...current, models: next };
  }
  return { name: provider.name, ...(provider.presetId != null ? { presetId: provider.presetId } : {}), agents };
}

/** `自研 3 · Claude Code 2` — a connected provider's row, in words. */
export function summarizeEnabled(provider: RedactedProviderConfig, label: (agent: ProviderAgent) => string): string {
  const parts = agentsOf(provider).map((agent) => `${label(agent)} ${provider.agents[agent]?.models.length ?? 0}`);
  return parts.join(" · ");
}

/** Matches a provider by name or id, for 查看全部's search box. */
export function filterCatalog(providers: readonly CatalogProviderSummary[], query: string): CatalogProviderSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...providers];
  return providers.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle));
}

/** `128K` / `1M`, for a model row's context column. */
export function formatContext(tokens: number | undefined): string {
  if (tokens == null) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

// --- 订阅 ---------------------------------------------------------------

/** A subscription counts as connected once its login is there; signed out or unknown, it is one more thing to connect. */
export function isSignedIn(account: SubscriptionAccount): boolean {
  return account.loggedIn === true;
}

/** The line under a subscription's name: whose login, which plan, who can use it. */
export function describeSubscription(account: SubscriptionAccount, label: (agent: ProviderAgent) => string): string {
  const served = `${account.agents.map(label).join(" · ")} 能用`;
  if (account.loggedIn == null) return `${served} · 查不到登录状态（没找到它的命令行工具）`;
  if (!account.loggedIn) return `${served} · 还没登录 · 不用 key`;
  // Signed in, who can use it is said by the model counts that follow; the account is what is worth the room.
  const parts = [account.email, account.plan != null ? planLabel(account.plan) : undefined, account.method != null ? `登录方式：${account.method}` : undefined].filter((part) => part != null);
  return parts.length > 0 ? parts.join(" · ") : "已登录";
}

/** `max` → `Max`. The vendors' own words, only capitalised: there is no list of plans to keep up with. */
function planLabel(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** How many of a subscription's models each agent has on: `自研 3 · Codex 5`. */
export function summarizeSubscription(account: SubscriptionAccount, label: (agent: ProviderAgent) => string): string {
  return account.agents.map((agent) => `${label(agent)} ${account.models.filter((model) => model.agents[agent]?.enabled === true).length}`).join(" · ");
}

/** The table as it will stand once the switch lands — shown at once, ahead of the server's answer. */
export function withSubscriptionSwitch(models: readonly SubscriptionModel[], agent: ProviderAgent, rowIds: readonly string[], enabled: boolean): SubscriptionModel[] {
  return models.map((model) => {
    const cell = model.agents[agent];
    return cell != null && rowIds.includes(model.id) ? { ...model, agents: { ...model.agents, [agent]: { ...cell, enabled } } } : model;
  });
}
