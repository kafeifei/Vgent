import { PROVIDER_PRESETS } from "./presets.js";
import { PROVIDER_PROTOCOLS, SDK_KINDS, type ProviderAgent, type ProviderModel, type ProviderProtocol } from "./provider-config.js";

/**
 * The provider catalog: every provider the settings page can connect, where it
 * lives, which AI SDK package speaks to it, and the models it is known to have.
 *
 * It is not written here. It is https://models.dev — the open catalog the AI
 * SDK ecosystem keeps, one entry per provider with the `npm` package that
 * reaches it — fetched by the server and cached. What this module adds is the
 * part models.dev does not know: which of those packages this build carries,
 * and where the same vendor serves the Anthropic protocol for the Claude Code
 * agent (taken from Cindy's presets, matched by host).
 */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** How one agent would reach a catalog provider. No `baseURL`: the endpoint is the user's own and the page asks for it. */
export interface CatalogEndpoint {
  baseURL?: string;
  protocol: ProviderProtocol;
}

export interface CatalogProvider {
  id: string;
  name: string;
  /** The AI SDK package the catalog says reaches it. */
  npm: string;
  docsUrl?: string;
  /** The agents this build can connect it to. Empty when it cannot at all — `unsupported` says why. */
  agents: Partial<Record<ProviderAgent, CatalogEndpoint>>;
  unsupported?: string;
  /** What the base URL looks like, when the user has to give one. */
  baseURLHint?: string;
  /** A local server and the like: there is no key to ask for. */
  keyless?: boolean;
  /** The models an agent can use: tool-calling, text out, not retired. Newest first. */
  models: ProviderModel[];
}

/** A catalog entry without its models — what the list of providers is drawn from. */
export type CatalogProviderSummary = Omit<CatalogProvider, "models"> & { modelCount: number };

/** The first rows of the page, in this order. Everything else is one search away. */
export const POPULAR_PROVIDER_IDS: readonly string[] = ["anthropic", "openai", "google", "openrouter", "deepseek", "moonshotai-cn", "zhipuai", "xai"];

const NPM_TO_PROTOCOL = new Map<string, ProviderProtocol>([
  ...PROVIDER_PROTOCOLS.map((protocol) => [SDK_KINDS[protocol].npm, protocol] as const),
  // OpenRouter's own package is a convenience over its OpenAI-compatible endpoint, which the catalog also gives.
  ["@openrouter/ai-sdk-provider", "openai-compatible"],
]);

function unsupportedReason(id: string, npm: string): string {
  if (id.startsWith("github-copilot")) return "使用应用的统一 GitHub 登录，请在账号与用量中管理";
  if (npm.startsWith("@ai-sdk/google-vertex")) return "要用 Google Cloud 的账号凭据，还没做";
  return `要用第三方适配包 ${npm}，还没接`;
}

function hostOf(url: string | undefined): string | undefined {
  if (url == null) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A provider's stored Anthropic base URL is the `claude` CLI's form, without the `/v1` the catalog includes. */
function withoutVersionSuffix(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

/** Where the vendor behind `baseURL` serves the Anthropic protocol, when Cindy's presets know. */
function claudeCodeBaseURLFor(baseURL: string | undefined): string | undefined {
  const host = hostOf(baseURL);
  if (host == null) return undefined;
  for (const preset of PROVIDER_PRESETS) {
    const claude = preset.agents["claude-code"];
    if (claude != null && hostOf(preset.agents.vgent?.baseURL) === host) return claude.baseURL;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

interface DatedModel extends ProviderModel {
  released: string;
}

/** models.dev's `reasoning_options: [{ type: "effort", values: [...] }, …]`, reduced to the effort values. */
function readReasoningLevels(record: Record<string, unknown>): string[] {
  if (record.reasoning !== true || !Array.isArray(record.reasoning_options)) return [];
  for (const option of record.reasoning_options as unknown[]) {
    if (typeof option !== "object" || option === null || (option as { type?: unknown }).type !== "effort") continue;
    const values = (option as { values?: unknown }).values;
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === "string" && value !== "");
  }
  return [];
}

/** One models.dev model → a row the page can tick, or undefined when an agent could not use it. */
function readModel(key: string, raw: unknown): DatedModel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  // An agent is nothing without tools.
  if (record.tool_call !== true) return undefined;
  if (record.status === "deprecated") return undefined;
  const output = (record.modalities as { output?: unknown } | undefined)?.output;
  if (Array.isArray(output) && !output.includes("text")) return undefined;
  // A model served through a different package than its provider (models.dev's per-model `provider`) is out of reach of one endpoint.
  if (typeof record.provider === "object" && record.provider !== null && text((record.provider as { npm?: unknown }).npm) != null) return undefined;
  const id = text(record.id) ?? key;
  const label = text(record.name);
  const context = (record.limit as { context?: unknown } | undefined)?.context;
  return {
    id,
    ...(label != null && label !== id ? { label } : {}),
    ...(typeof context === "number" && Number.isFinite(context) && context > 0 ? { contextWindow: context } : {}),
    reasoningLevels: readReasoningLevels(record),
    released: text(record.release_date) ?? "",
  };
}

function readProvider(key: string, raw: unknown): CatalogProvider | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const id = text(record.id) ?? key;
  const name = text(record.name) ?? id;
  const npm = text(record.npm) ?? "";
  const docsUrl = text(record.doc);

  const dated: DatedModel[] = [];
  if (typeof record.models === "object" && record.models !== null) {
    for (const [modelKey, model] of Object.entries(record.models)) {
      const parsed = readModel(modelKey, model);
      if (parsed != null) dated.push(parsed);
    }
  }
  dated.sort((a, b) => (a.released === b.released ? a.id.localeCompare(b.id) : a.released < b.released ? 1 : -1));
  const models = dated.map(({ released: _released, ...model }) => model);

  const base = { id, name, npm, ...(docsUrl != null ? { docsUrl } : {}), models };
  const protocol = NPM_TO_PROTOCOL.get(npm);
  if (protocol == null || id.startsWith("github-copilot")) return { ...base, agents: {}, unsupported: unsupportedReason(id, npm) };

  const kind = SDK_KINDS[protocol];
  const api = text(record.api);
  // `https://…/accounts/${ACCOUNT_ID}/…`: the catalog's way of saying part of the address is the user's.
  const templated = api != null && api.includes("${");
  const catalogURL = api == null || templated ? undefined : api.replace(/\/+$/, "");
  const vgentURL = protocol === "anthropic" && catalogURL != null ? withoutVersionSuffix(catalogURL) : (catalogURL ?? kind.defaultBaseURL);
  const hint = templated ? api : vgentURL == null ? kind.baseURLHint : undefined;

  const agents: CatalogProvider["agents"] = { vgent: { protocol, ...(vgentURL != null ? { baseURL: vgentURL } : {}) } };
  const claudeURL = protocol === "anthropic" ? vgentURL : claudeCodeBaseURLFor(vgentURL);
  if (claudeURL != null) agents["claude-code"] = { protocol: "anthropic", baseURL: claudeURL };
  // Codex speaks OpenAI's Responses API and nothing else. The catalog says who
  // does by naming `@ai-sdk/openai` as the package — the one that talks
  // Responses — rather than the chat-completions `openai-compatible` one.
  if (protocol === "openai") agents.codex = { protocol: "openai", ...(vgentURL != null ? { baseURL: vgentURL } : {}) };

  return { ...base, agents, ...(hint != null ? { baseURLHint: hint } : {}) };
}

/** What models.dev does not list: servers on this machine. Their models come from the live listing. */
const LOCAL_PROVIDERS: readonly CatalogProvider[] = [
  {
    id: "ollama",
    name: "Ollama（本机）",
    npm: SDK_KINDS["openai-compatible"].npm,
    docsUrl: "https://docs.ollama.com/api/openai-compatibility",
    agents: { vgent: { protocol: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" } },
    keyless: true,
    models: [],
  },
];

/**
 * models.dev's `api.json` → the catalog. Tolerant on purpose: an entry it cannot
 * read is skipped, never fatal, because the file is someone else's and changes
 * without notice. Throws only when the whole payload is not the expected map.
 */
export function normalizeModelsDev(payload: unknown): CatalogProvider[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("models.dev 的返回格式认不出来");
  const providers: CatalogProvider[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(payload)) {
    const provider = readProvider(key, raw);
    if (provider == null || seen.has(provider.id)) continue;
    seen.add(provider.id);
    // LM Studio is in the catalog with a placeholder key variable; it takes none.
    providers.push(hostOf(provider.agents.vgent?.baseURL)?.startsWith("127.0.0.1") === true ? { ...provider, keyless: true } : provider);
  }
  if (providers.length === 0) throw new Error("models.dev 返回了空目录");
  for (const local of LOCAL_PROVIDERS) if (!seen.has(local.id)) providers.push(local);
  return providers;
}

/**
 * The catalog when models.dev has never been reachable: Cindy's presets, which
 * ship with the build. Small, but enough to connect the vendors it names.
 */
export function builtinCatalog(): CatalogProvider[] {
  const fromPresets = PROVIDER_PRESETS.map((preset): CatalogProvider => {
    const agents: CatalogProvider["agents"] = {};
    const models = new Map<string, ProviderModel>();
    for (const [agent, config] of Object.entries(preset.agents)) {
      agents[agent as ProviderAgent] = { protocol: config.protocol, baseURL: config.baseURL };
      for (const model of config.models) if (!models.has(model.id)) models.set(model.id, model);
    }
    return {
      id: preset.id,
      name: preset.name,
      npm: SDK_KINDS[preset.agents.vgent?.protocol ?? "anthropic"].npm,
      ...(preset.docsUrl != null ? { docsUrl: preset.docsUrl } : {}),
      agents,
      models: [...models.values()],
    };
  });
  return [...fromPresets, ...LOCAL_PROVIDERS];
}

export function summarizeCatalogProvider(provider: CatalogProvider): CatalogProviderSummary {
  const { models, ...rest } = provider;
  return { ...rest, modelCount: models.length };
}

export interface FetchCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Downloads and normalizes the catalog. Throws when models.dev cannot be reached or answers nonsense. */
export async function fetchProviderCatalog(options: FetchCatalogOptions = {}): Promise<CatalogProvider[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal == null ? timeout : AbortSignal.any([options.signal, timeout]);
  const response = await fetchImpl(MODELS_DEV_URL, { headers: { accept: "application/json" }, signal });
  if (!response.ok) throw new Error(`models.dev 返回 HTTP ${response.status}`);
  return normalizeModelsDev(await response.json());
}

/**
 * The spellings a model id is looked up by, most exact first. A gateway names
 * models its own way — `anthropic-claude/claude-opus-5`, `codex/gpt-5.5:auto`,
 * `claude-haiku-4-5-20251001`, `Claude-Opus-4.5` — and they are all a model the
 * catalog knows under a plainer name:
 *
 * 1. the last path segment, lowercased (the vendor prefix is the gateway's);
 * 2. that, without what gateways append: a `:variant`, Claude Code's `[1m]`,
 *    a `-latest`, a trailing date;
 * 3. that, with `.` and `_` read as `-` (`claude-opus-4.5` is `claude-opus-4-5`).
 *
 * Each step only ever removes decoration; none of them guesses at a *different*
 * model (no dropping of `-mini`, `-pro`, version numbers), so a miss stays a miss.
 */
export function modelKeys(id: string): string[] {
  const tail = id.slice(id.lastIndexOf("/") + 1).toLowerCase().trim();
  const bare = tail
    .replace(/\[[^\]]*\]$/, "")
    .replace(/:[^:]*$/, "")
    .replace(/-latest$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  const dashed = bare.replace(/[._]/g, "-");
  return [...new Set([tail, bare, dashed])].filter((key) => key !== "");
}

/** A catalog row, and whose it is: the id of the provider whose own listing it was found in (`openai`, `anthropic`, …). */
export type CatalogModelMatch = ProviderModel & { vendor: string };

/**
 * 「目录对这个模型知道什么」— its effort levels, its context window — answered
 * for a model id that may have come from anywhere: a company gateway's
 * `vendor/model`, a relay's bare name. The vendor's own entry wins over a
 * reseller's copy of the same model: an aggregator lists models as
 * `vendor/model`, a vendor lists its own bare, so bare ids are read first (the
 * popular providers ahead of the rest), and the `vendor/model` rows only fill in
 * what no vendor listed. An id the catalog has never seen answers undefined
 * rather than a guess.
 */
export function createModelIndex(providers: readonly CatalogProvider[]): (modelId: string) => CatalogModelMatch | undefined {
  const index = new Map<string, CatalogModelMatch>();
  const rank = (provider: CatalogProvider): number => {
    const at = POPULAR_PROVIDER_IDS.indexOf(provider.id);
    return at < 0 ? POPULAR_PROVIDER_IDS.length : at;
  };
  const ordered = [...providers].sort((a, b) => rank(a) - rank(b));
  // Exact names are all registered before any looser spelling is, so a loose key never shadows a model really called that.
  for (const level of [0, 1, 2]) {
    for (const resold of [false, true]) {
      for (const provider of ordered) {
        for (const model of provider.models) {
          if (model.id.includes("/") !== resold) continue;
          const key = modelKeys(model.id)[level];
          if (key != null && !index.has(key)) index.set(key, { ...model, vendor: provider.id });
        }
      }
    }
  }
  return (modelId) => {
    for (const key of modelKeys(modelId)) {
      const hit = index.get(key);
      if (hit != null) return hit;
    }
    return undefined;
  };
}

/** 「这个模型有哪几档推理强度」: {@link createModelIndex}, reduced to the levels. */
export function createReasoningIndex(providers: readonly CatalogProvider[]): (modelId: string) => string[] | undefined {
  const modelOf = createModelIndex(providers);
  return (modelId) => modelOf(modelId)?.reasoningLevels;
}
