/**
 * A user-configured model provider: one account (an endpoint family and a key)
 * and, per agent, where that agent reaches it and which of its models the user
 * ticked. This is the whole 「每个 agent 用哪些模型」 table — there is no second
 * one to keep in step with it.
 *
 * Zero dependencies on purpose: the server validates request bodies with
 * `parseProviderInput`, and the web app reads the same types.
 */

/** The agents a provider's models can be offered to. */
export const PROVIDER_AGENTS = ["vgent", "claude-code", "codex"] as const;
export type ProviderAgent = (typeof PROVIDER_AGENTS)[number];

/**
 * How an endpoint is spoken to — which AI SDK provider package the in-house
 * agent builds for it. `openai-compatible` and `anthropic` cover any endpoint
 * that copies those two APIs; the rest are the vendors' own packages, which know
 * their API's extras (OpenAI's Responses API, Gemini's native one, …). The
 * Claude Code agent only ever talks `anthropic`.
 */
export const PROVIDER_PROTOCOLS = [
  "openai-compatible",
  "anthropic",
  "openai",
  "google",
  "xai",
  "mistral",
  "groq",
  "deepinfra",
  "cerebras",
  "togetherai",
  "cohere",
  "perplexity",
  "azure",
  "amazon-bedrock",
  "gateway",
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

export interface SdkKind {
  /** The AI SDK package behind this protocol. */
  npm: string;
  label: string;
  /** Where the package points on its own. Absent: the endpoint is the user's own and has to be given. */
  defaultBaseURL?: string;
  /** What a base URL of this kind looks like, for the field's placeholder. */
  baseURLHint?: string;
  /** How the model listing is asked for; `none` when the vendor serves nothing a key can read. */
  listing: "openai" | "anthropic" | "google" | "none";
  /** The listing's path under the base URL, when it is not `/models`. */
  listingPath?: string;
}

/** One row per protocol: the package, its default endpoint, and how its model listing is read. */
export const SDK_KINDS: Record<ProviderProtocol, SdkKind> = {
  "openai-compatible": { npm: "@ai-sdk/openai-compatible", label: "OpenAI 兼容", baseURLHint: "https://example.com/v1", listing: "openai" },
  anthropic: { npm: "@ai-sdk/anthropic", label: "Anthropic", defaultBaseURL: "https://api.anthropic.com", listing: "anthropic" },
  openai: { npm: "@ai-sdk/openai", label: "OpenAI", defaultBaseURL: "https://api.openai.com/v1", listing: "openai" },
  google: { npm: "@ai-sdk/google", label: "Google Gemini", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta", listing: "google" },
  xai: { npm: "@ai-sdk/xai", label: "xAI", defaultBaseURL: "https://api.x.ai/v1", listing: "openai" },
  mistral: { npm: "@ai-sdk/mistral", label: "Mistral", defaultBaseURL: "https://api.mistral.ai/v1", listing: "openai" },
  groq: { npm: "@ai-sdk/groq", label: "Groq", defaultBaseURL: "https://api.groq.com/openai/v1", listing: "openai" },
  deepinfra: { npm: "@ai-sdk/deepinfra", label: "DeepInfra", defaultBaseURL: "https://api.deepinfra.com/v1", listing: "openai", listingPath: "/openai/models" },
  cerebras: { npm: "@ai-sdk/cerebras", label: "Cerebras", defaultBaseURL: "https://api.cerebras.ai/v1", listing: "openai" },
  togetherai: { npm: "@ai-sdk/togetherai", label: "Together AI", defaultBaseURL: "https://api.together.xyz/v1", listing: "openai" },
  cohere: { npm: "@ai-sdk/cohere", label: "Cohere", defaultBaseURL: "https://api.cohere.com/v2", listing: "none" },
  perplexity: { npm: "@ai-sdk/perplexity", label: "Perplexity", defaultBaseURL: "https://api.perplexity.ai", listing: "none" },
  azure: { npm: "@ai-sdk/azure", label: "Azure OpenAI", baseURLHint: "https://<资源名>.openai.azure.com/openai", listing: "none" },
  "amazon-bedrock": { npm: "@ai-sdk/amazon-bedrock", label: "Amazon Bedrock", baseURLHint: "https://bedrock-runtime.<区域>.amazonaws.com", listing: "none" },
  gateway: { npm: "@ai-sdk/gateway", label: "Vercel AI Gateway", defaultBaseURL: "https://ai-gateway.vercel.sh/v4/ai", listing: "none" },
};

/** One model of a provider, as the picker shows it. */
export interface ProviderModel {
  /** The id the provider's API expects. */
  id: string;
  /** Display name; the id is shown when absent. */
  label?: string;
  /** Usable context window in tokens, when the source knew it. */
  contextWindow?: number;
}

/** How one agent reaches the provider, and the models the user enabled for it. */
export interface ProviderAgentConfig {
  baseURL: string;
  /** Which AI SDK package the in-house agent builds for it; Claude Code is always `anthropic`. */
  protocol: ProviderProtocol;
  /** The ticked models, in the order the picker lists them. */
  models: ProviderModel[];
}

export interface ProviderConfig {
  /**
   * Lowercase slug, unique among providers. It is the prefix of every model id
   * of this provider (`<id>:<model>`), i.e. the AI SDK registry's provider id.
   */
  id: string;
  name: string;
  /** The preset this provider was created from, when there was one. */
  presetId?: string;
  /** The secret. Lives only in the server's provider store; never sent to a client. */
  apiKey?: string;
  /** Only the agents the user configured. */
  agents: Partial<Record<ProviderAgent, ProviderAgentConfig>>;
}

/** What a client is given: everything but the key, plus whether there is one. */
export type RedactedProviderConfig = Omit<ProviderConfig, "apiKey"> & { hasKey: boolean };

/** Ids the registry already uses for its built-in sources; a provider must not shadow them. */
export const RESERVED_PROVIDER_IDS: readonly string[] = ["codex-subscription", "gateway"];

/** The `:` every registry model id is split on. */
export const PROVIDER_MODEL_SEPARATOR = ":";

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_MODELS_PER_AGENT = 200;

export function redactProvider(provider: ProviderConfig): RedactedProviderConfig {
  const { apiKey, ...rest } = provider;
  return { ...rest, hasKey: apiKey != null && apiKey !== "" };
}

/** `<providerId>:<modelId>` — what a thread's `model` field carries for a provider model. */
export function providerModelSpec(providerId: string, modelId: string): string {
  return `${providerId}${PROVIDER_MODEL_SEPARATOR}${modelId}`;
}

/**
 * Splits a model spec on its first separator. Returns undefined when there is
 * none, or when either side would be empty — such a string is not a provider
 * spec (a gateway `provider/model` string, for one, has no `:`).
 */
export function splitProviderModelSpec(spec: string): { providerId: string; modelId: string } | undefined {
  const at = spec.indexOf(PROVIDER_MODEL_SEPARATOR);
  if (at <= 0 || at === spec.length - 1) return undefined;
  return { providerId: spec.slice(0, at), modelId: spec.slice(at + 1) };
}

/** A slug for a new provider, derived from its name; the caller de-duplicates it. */
export function slugifyProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug === "" ? "provider" : slug;
}

function readBaseURL(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}.baseURL 必须是非空字符串`);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${where}.baseURL 不是合法的 URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${where}.baseURL 只能是 http 或 https`);
  // A trailing slash would double up when the SDK appends its path.
  return value.trim().replace(/\/+$/, "");
}

function readModels(value: unknown, where: string): ProviderModel[] {
  if (!Array.isArray(value)) throw new Error(`${where}.models 必须是数组`);
  if (value.length > MAX_MODELS_PER_AGENT) throw new Error(`${where}.models 最多 ${MAX_MODELS_PER_AGENT} 个`);
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "object" || entry === null) throw new Error(`${where}.models[${index}] 必须是对象`);
    const { id, label, contextWindow } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.trim() === "") throw new Error(`${where}.models[${index}].id 必须是非空字符串`);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      ...(typeof label === "string" && label.trim() !== "" ? { label: label.trim() } : {}),
      ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    });
  }
  return models;
}

function readAgents(value: unknown): ProviderConfig["agents"] {
  if (typeof value !== "object" || value === null) throw new Error("agents 必须是对象");
  const agents: ProviderConfig["agents"] = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(PROVIDER_AGENTS as readonly string[]).includes(key)) throw new Error(`未知的 agent: ${JSON.stringify(key)}`);
    if (raw == null) continue;
    if (typeof raw !== "object") throw new Error(`agents.${key} 必须是对象`);
    const agent = key as ProviderAgent;
    const where = `agents.${key}`;
    const record = raw as Record<string, unknown>;
    // Claude Code speaks Anthropic Messages and nothing else, whatever was sent.
    const protocol = agent === "claude-code" ? "anthropic" : (record.protocol ?? "openai-compatible");
    if (!(PROVIDER_PROTOCOLS as readonly unknown[]).includes(protocol)) {
      throw new Error(`${where}.protocol 不认识：${JSON.stringify(protocol)}`);
    }
    agents[agent] = {
      baseURL: readBaseURL(record.baseURL, where),
      protocol: protocol as ProviderProtocol,
      models: readModels(record.models ?? [], where),
    };
  }
  if (Object.keys(agents).length === 0) throw new Error("至少要配置一个 agent");
  return agents;
}

/**
 * What a create / update request may carry. `apiKey` has three states on an
 * update: absent keeps the stored key, `""` clears it, anything else replaces it.
 */
export interface ProviderInput {
  id?: string;
  name: string;
  presetId?: string;
  apiKey?: string;
  agents: ProviderConfig["agents"];
}

/** Validates a request body. Throws an `Error` whose message is fit to show the user. */
export function parseProviderInput(value: unknown): ProviderInput {
  if (typeof value !== "object" || value === null) throw new Error("请求体必须是对象");
  const record = value as Record<string, unknown>;
  const { id, name, presetId, apiKey } = record;
  if (typeof name !== "string" || name.trim() === "") throw new Error("name 必须是非空字符串");
  if (id !== undefined) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("id 只能是小写字母、数字、- 和 _，且不超过 40 个字符");
    if (RESERVED_PROVIDER_IDS.includes(id)) throw new Error(`id ${JSON.stringify(id)} 是内置来源，不能占用`);
  }
  if (presetId !== undefined && typeof presetId !== "string") throw new Error("presetId 必须是字符串");
  if (apiKey !== undefined && typeof apiKey !== "string") throw new Error("apiKey 必须是字符串");
  return {
    ...(id !== undefined ? { id } : {}),
    name: name.trim(),
    ...(presetId !== undefined && presetId !== "" ? { presetId } : {}),
    ...(apiKey !== undefined ? { apiKey: apiKey.trim() } : {}),
    agents: readAgents(record.agents),
  };
}

/** True when a stored value has the shape of a provider; the store quarantines a file that fails it. */
export function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && typeof record.agents === "object" && record.agents !== null;
}
