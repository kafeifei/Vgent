import { anthropicSdkBaseURL } from "./model-registry.js";
import { SDK_KINDS, type ProviderModel, type ProviderProtocol } from "./provider-config.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const ANTHROPIC_VERSION = "2023-06-01";

export interface DiscoverModelsOptions {
  baseURL: string;
  protocol: ProviderProtocol;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** A listing that could not be had. `status` is the HTTP status when the endpoint answered at all. */
export class ModelDiscoveryError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ModelDiscoveryError";
    if (status != null) this.status = status;
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One entry of any listing shape → a `ProviderModel`. Unknown fields are ignored; an entry without an id is dropped. */
function toModel(entry: unknown): ProviderModel | undefined {
  if (typeof entry === "string") return entry === "" ? undefined : { id: entry };
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  // Gemini names a model `models/<id>` and says nothing under `id`.
  const geminiName = typeof record.name === "string" && record.name.startsWith("models/") ? record.name.slice("models/".length) : undefined;
  const id = typeof record.id === "string" ? record.id : geminiName;
  if (id == null || id === "") return undefined;
  // Gemini lists embedding and image models in the same breath; only the ones that can hold a conversation are wanted.
  if (Array.isArray(record.supportedGenerationMethods) && !record.supportedGenerationMethods.includes("generateContent")) return undefined;
  // OpenAI-compatible servers say `name` (OpenRouter) or nothing; Anthropic says `display_name`; Gemini `displayName`.
  const label = [record.display_name, record.displayName, geminiName == null ? record.name : undefined].find(
    (value): value is string => typeof value === "string" && value !== "" && value !== id,
  );
  // OpenRouter: `context_length`; LiteLLM and a few others: `context_window` / `max_input_tokens`; Gemini: `inputTokenLimit`.
  const contextWindow =
    positive(record.context_length) ?? positive(record.context_window) ?? positive(record.max_input_tokens) ?? positive(record.inputTokenLimit);
  return { id, ...(label != null ? { label } : {}), ...(contextWindow != null ? { contextWindow } : {}) };
}

/** OpenAI and Anthropic answer `{ data: [...] }`, Gemini `{ models: [...] }`; a bare array turns up on Together and self-hosted servers. */
function readListing(payload: unknown): ProviderModel[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? ((payload as { data?: unknown }).data ?? (payload as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) throw new ModelDiscoveryError("模型列表的返回格式认不出来");
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of list) {
    const model = toModel(entry);
    if (model == null || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** True when a protocol's vendor serves a model listing that a key can read. */
export function canDiscoverModels(protocol: ProviderProtocol): boolean {
  return SDK_KINDS[protocol].listing !== "none";
}

/**
 * Asks a provider which models it has. The shape of the question follows the
 * protocol (see `SDK_KINDS`): `GET <baseURL>/models` with a Bearer key for the
 * OpenAI family, `GET <baseURL>/v1/models` for Anthropic, `GET <baseURL>/models`
 * with `x-goog-api-key` for Gemini. Many Anthropic-compatible endpoints do not
 * serve a listing at all; that is a `ModelDiscoveryError` with the 404, and the
 * caller falls back to the catalog's models.
 *
 * The key is sent and never echoed: no error message built here contains it.
 */
export async function discoverProviderModels(options: DiscoverModelsOptions): Promise<ProviderModel[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const key = options.apiKey ?? "";
  const kind = SDK_KINDS[options.protocol];
  if (kind.listing === "none") throw new ModelDiscoveryError(`${kind.label} 不提供能用 key 读的模型列表`);
  const base = options.baseURL.replace(/\/+$/, "");
  const headers: Record<string, string> = { accept: "application/json" };
  let url: string;
  if (kind.listing === "anthropic") {
    url = `${anthropicSdkBaseURL(base)}/models?limit=1000`;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key !== "") {
      headers["x-api-key"] = key;
      headers.authorization = `Bearer ${key}`;
    }
  } else if (kind.listing === "google") {
    url = `${base}/models?pageSize=1000`;
    if (key !== "") headers["x-goog-api-key"] = key;
  } else {
    url = `${base}${kind.listingPath ?? "/models"}`;
    if (key !== "") headers.authorization = `Bearer ${key}`;
  }

  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = options.signal == null ? timeout : AbortSignal.any([options.signal, timeout]);

  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "超时" : "连接失败";
    throw new ModelDiscoveryError(`拉取模型列表${reason}：${new URL(url).host}`);
  }
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? "，key 不对或没有权限" : response.status === 404 ? "，这个地址不提供模型列表" : "";
    throw new ModelDiscoveryError(`拉取模型列表失败（HTTP ${response.status}）${hint}`, response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelDiscoveryError("模型列表不是合法的 JSON");
  }
  return readListing(payload);
}
