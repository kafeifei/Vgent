import { anthropicSdkBaseURL } from "./model-registry.js";
import type { ProviderModel, ProviderProtocol } from "./provider-config.js";

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

/** One entry of either listing shape → a `ProviderModel`. Unknown fields are ignored; an entry without an id is dropped. */
function toModel(entry: unknown): ProviderModel | undefined {
  if (typeof entry === "string") return entry === "" ? undefined : { id: entry };
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || id === "") return undefined;
  // OpenAI-compatible servers say `name` (OpenRouter) or nothing; Anthropic says `display_name`.
  const label = [record.display_name, record.name].find((value): value is string => typeof value === "string" && value !== "" && value !== id);
  // OpenRouter: `context_length`; LiteLLM and a few others: `context_window` / `max_input_tokens`.
  const contextWindow = positive(record.context_length) ?? positive(record.context_window) ?? positive(record.max_input_tokens);
  return { id, ...(label != null ? { label } : {}), ...(contextWindow != null ? { contextWindow } : {}) };
}

/** Both protocols answer `{ data: [...] }`; a bare array and `{ models: [...] }` turn up on self-hosted servers. */
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

/**
 * Asks a provider which models it has: `GET <baseURL>/models` for an
 * OpenAI-compatible endpoint, `GET <baseURL>/v1/models` for an
 * Anthropic-compatible one. Many Anthropic-compatible endpoints do not serve a
 * listing at all; that is a `ModelDiscoveryError` with the 404, and the caller
 * falls back to the preset's seed models.
 *
 * The key is sent and never echoed: no error message built here contains it.
 */
export async function discoverProviderModels(options: DiscoverModelsOptions): Promise<ProviderModel[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const key = options.apiKey ?? "";
  const anthropic = options.protocol === "anthropic";
  const url = anthropic ? `${anthropicSdkBaseURL(options.baseURL)}/models?limit=1000` : `${options.baseURL.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (key !== "") headers.authorization = `Bearer ${key}`;
  if (anthropic) {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (key !== "") headers["x-api-key"] = key;
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
