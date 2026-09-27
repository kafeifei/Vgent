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

/** Which agents a custom connection serves besides its own: what 连接设置 lets the user change after the fact. */
export interface AgentChoices {
  /** Codex shares the OpenAI-compatible address (it speaks Responses there). */
  codex: boolean;
  /** Claude Code's Anthropic-compatible address; empty means it does not use this provider. */
  claudeBaseURL: string;
}

/**
 * A custom provider's agents after 连接设置: the same two choices the 自定义
 * dialog offers, applied to a connection that already exists. An agent that is
 * switched on starts with no models ticked; one that stays keeps its list; one
 * that is switched off is dropped with its list.
 */
export function withAgentChoices(
  agents: RedactedProviderConfig["agents"],
  choices: AgentChoices,
  usable: readonly ProviderAgent[],
  /** The agents as they were before this edit; `agents` may already carry a changed address. */
  before: RedactedProviderConfig["agents"] = agents,
): { agents: RedactedProviderConfig["agents"] } | { error: string } {
  const next = { ...agents };
  const shared = next.vgent;
  if (usable.includes("codex") && shared?.protocol === "openai-compatible") {
    // Codex follows the shared address — unless it was given one of its own, which is not ours to overwrite.
    const follows = before.codex == null || before.codex.baseURL === before.vgent?.baseURL;
    if (choices.codex) {
      next.codex = { protocol: "openai", models: [], ...next.codex, baseURL: follows || next.codex == null ? shared.baseURL : next.codex.baseURL };
    }
    else delete next.codex;
  }
  if (usable.includes("claude-code") && shared?.protocol === "openai-compatible") {
    const claudeURL = choices.claudeBaseURL.trim().replace(/\/+$/, "");
    if (claudeURL === "") delete next["claude-code"];
    else {
      const problem = checkURL(claudeURL, "Claude Code 的接入地址");
      if (problem != null) return { error: problem };
      next["claude-code"] = { ...(next["claude-code"] ?? { protocol: "anthropic" as const, models: [] }), baseURL: claudeURL };
    }
  }
  return { agents: next };
}

/** The agents a connected provider has an endpoint for, in column order. */
export function agentsOf(provider: RedactedProviderConfig, available?: readonly ProviderAgent[]): ProviderAgent[] {
  const configured = AGENT_ORDER.filter((agent) => provider.agents[agent] != null);
  if (available == null) return configured;
  return AGENT_ORDER.filter((agent) => configured.includes(agent) || available.includes(agent));
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
  } else if (on && models.length > 0) {
    // Force-enabling another engine reuses the first configured endpoint. The
    // server normalizes Claude Code/Codex to their required protocol.
    const fallback = AGENT_ORDER.map((candidate) => provider.agents[candidate]).find((entry) => entry != null);
    if (fallback != null) agents[agent] = { ...fallback, models: [...models] };
  }
  return { name: provider.name, ...(provider.presetId != null ? { presetId: provider.presetId } : {}), agents };
}

/** `自研 3 · Claude Code 2` — a connected provider's row, in words. */
export function summarizeEnabled(provider: RedactedProviderConfig, label: (agent: ProviderAgent) => string): string {
  const parts = agentsOf(provider).map((agent) => `${label(agent)} ${provider.agents[agent]?.models.length ?? 0}`);
  return parts.join(" · ");
}

/** Matches a provider by name or id, for the catalog's search box. */
export function filterCatalog(providers: readonly CatalogProviderSummary[], query: string): CatalogProviderSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...providers];
  return providers.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle));
}

/** 添加 → 更多 N 个提供商: what this build can connect, by name. The rest is not offered at all. */
export function connectableCatalog(providers: readonly CatalogProviderSummary[], query = ""): CatalogProviderSummary[] {
  return filterCatalog(providers, query)
    .filter((entry) => entry.unsupported == null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `128K` / `1M`, for a model row's context column. */
export function formatContext(tokens: number | undefined): string {
  if (tokens == null) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

// --- 订阅 ---------------------------------------------------------------

/** Signed in, a subscription is one of「已添加」; otherwise it waits in the 添加 menu. */
export function isSignedIn(account: SubscriptionAccount): boolean {
  return account.loggedIn === true;
}

const SIGN_IN_ORDER: readonly SubscriptionAccount["id"][] = ["codex-subscription", "claude-subscription", "github-copilot"];

/** The logins the 添加 menu offers: the ones not signed in — Codex, Claude, then GitHub. */
export function toSignIn(accounts: readonly SubscriptionAccount[]): SubscriptionAccount[] {
  return SIGN_IN_ORDER.flatMap((id) => accounts.find((account) => account.id === id && !isSignedIn(account)) ?? []);
}

/** The line under a subscription's name: whose login, which plan, who can use it. */
export function describeSubscription(account: SubscriptionAccount, label: (agent: ProviderAgent) => string): string {
  const served = `${account.agents.map(label).join(" · ")} 能用`;
  if (account.loggedIn == null) return `${served} · 暂时无法确认登录状态`;
  if (!account.loggedIn) return `${served} · 还没登录 · 不用 key`;
  // Signed in, who can use it is said by the model counts that follow; the account is what is worth the room.
  const parts = [account.username ? `@${account.username}` : account.email, account.plan != null ? planLabel(account.plan) : undefined, account.method != null ? `登录方式：${account.method}` : undefined].filter((part) => part != null);
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

/** One row of「已添加」: a login or a connected provider, keyed the way `Settings.providerOrder` names it. */
export type AddedEntry = { key: string; account: SubscriptionAccount; provider?: never } | { key: string; provider: RedactedProviderConfig; account?: never };

/**
 * 「已添加」in 提供商排序: the ones the user placed, in their order, then the rest
 * as they come — the logins first, then the providers in connection order.
 */
export function orderAdded(accounts: readonly SubscriptionAccount[], providers: readonly RedactedProviderConfig[], order: readonly string[] | undefined): AddedEntry[] {
  const entries: AddedEntry[] = [...accounts.map((account) => ({ key: account.id, account })), ...providers.map((provider) => ({ key: provider.id, provider }))];
  const rankOf = (entry: AddedEntry) => {
    const at = order?.indexOf(entry.key) ?? -1;
    return at < 0 ? Number.POSITIVE_INFINITY : at;
  };
  return entries
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => rankOf(a.entry) - rankOf(b.entry) || a.at - b.at)
    .map(({ entry }) => entry);
}

/**
 * 提供商排序 after a drag of the rows on screen. A login that is signed out is
 * not on screen but keeps its place, so it comes back where it was.
 */
export function withShownOrder(saved: readonly string[] | undefined, shown: readonly string[]): string[] {
  const visible = new Set(shown);
  const queue = [...shown];
  const next = (saved ?? []).flatMap((key) => (visible.has(key) ? (queue.shift() ?? []) : key));
  return [...next, ...queue];
}
