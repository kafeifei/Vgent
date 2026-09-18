import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CODEX_SUBSCRIPTION_PREFIX } from "@vgent/engine";
import { CHATGPT_CODEX_BASE_URL, CodexTokenProvider, createCodexFetch, describeSubscriptionAuth } from "@vgent/providers";
import { gateway as defaultGateway } from "ai";
import type { EngineId, Logger } from "./types.js";
import { silentLogger } from "./types.js";

/** One selectable model. `id` is what a thread's `model` field is set to. */
export interface ModelEntry {
  id: string;
  label: string;
  description?: string;
  /**
   * The「思考等级」this model offers, in the order the picker should show them.
   * Absent means the model has none to choose from and the chip stays hidden —
   * never guessed, only ever taken from the source that knows (Codex's own
   * catalog, the Claude Code harness's `thinking` setting, OpenAI's documented
   * reasoning efforts).
   */
  reasoningLevels?: string[];
  /** Which of `reasoningLevels` applies when the thread names none. */
  defaultReasoningLevel?: string;
  /**
   * The model's usable context window in tokens — the denominator of the
   * composer's context ring. Only sources that report one fill it: Codex does
   * (`context_window`), while the Anthropic models API and the AI Gateway list
   * do not, so it stays undefined there and the client falls back to its own
   * default.
   */
  contextWindow?: number;
}

/** The two reasoning fields of a `ModelEntry`, as the builders below merge them in. */
type ReasoningLevels = Pick<ModelEntry, "reasoningLevels" | "defaultReasoningLevel">;

/**
 * What `GET /api/engines/:engine/models` answers. `source` names where the list
 * came from (`+`-joined when an engine merges two sources); `warning` says, in
 * Chinese, why a better source was skipped.
 */
export interface ModelCatalog {
  engine: EngineId;
  models: ModelEntry[];
  source: string;
  fetchedAt: string;
  warning?: string;
  /**
   * The model id the server actually uses for this engine when a task names
   * none, so「默认」in the picker still resolves to a real model — the client
   * needs it for the model chip, the 思考 levels and the ring's denominator.
   * Undefined when only the harness knows (Claude Code and Codex pick their
   * own default, and inventing one here would make the chip lie).
   */
  defaultModel?: string;
}

export interface ModelCatalogService {
  list(engine: EngineId, options?: { refresh?: boolean }): Promise<ModelCatalog>;
}

/** One entry of Codex's own catalog, as both the cache file and the backend spell it. */
export interface CodexCatalogModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  /**
   * Normalized to the bare level ids (`["low", "medium", "high", "xhigh",
   * "max", "ultra"]`); the wire shape is a list of `{ effort, description }`.
   */
  supported_reasoning_levels?: string[];
  default_reasoning_level?: string;
  /**
   * The window this model actually runs with. The payload also carries a larger
   * `max_context_window` (what the model could do on another tier); the ring
   * has to measure against the one in force, so only this one is read.
   */
  context_window?: number;
}

/** The slice of the gateway provider this module needs; tests pass a fake. */
export interface GatewayModelSource {
  getAvailableModels(): Promise<{
    models: Array<{ id: string; name?: string; description?: string | null; modelType?: string | null }>;
  }>;
}

export interface ModelCatalogOptions {
  log?: Logger;
  /** Clock behind the TTL. Tests advance it instead of waiting. */
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Test seam for the Codex backend catalog; production hits it through `createCodexFetch`. */
  fetchCodexRemote?: (input: { clientVersion: string; signal: AbortSignal }) => Promise<CodexCatalogModel[]>;
  gateway?: GatewayModelSource;
}

/** How long a fetched catalog is reused. A picker opening twice must not refetch. */
const CATALOG_TTL_MS = 10 * 60_000;
const REMOTE_TIMEOUT_MS = 5_000;

/**
 * `client_version` the Codex backend requires on `GET /models` — it answers 400
 * without one. The locally cached catalog carries the version the installed CLI
 * sent; this is only the floor for a machine that has never run `codex`.
 */
const FALLBACK_CODEX_CLIENT_VERSION = "0.155.0";

/** Either of these lets the AI Gateway authenticate a `provider/model` spec. */
const GATEWAY_ENV_VARS = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const;

const CODEX_BUILTIN: ModelEntry[] = [{ id: "gpt-5.5", label: "gpt-5.5" }];

const VGENT_BUILTIN: ModelEntry[] = [
  { id: `${CODEX_SUBSCRIPTION_PREFIX}gpt-5.5`, label: `${CODEX_SUBSCRIPTION_PREFIX}gpt-5.5` },
];

/**
 * The Claude Agent SDK has no list endpoint, and the harness passes `model`
 * through verbatim. These three aliases are what it accepts besides a full id
 * (`@ai-sdk/harness-claude-code` types them as `"sonnet" | "opus" | "haiku"`).
 */
const CLAUDE_CODE_BUILTIN: ModelEntry[] = [
  { id: "sonnet", label: "sonnet", description: "别名：当前默认的 Sonnet 版本" },
  { id: "opus", label: "opus", description: "别名：当前默认的 Opus 版本" },
  { id: "haiku", label: "haiku", description: "别名：当前默认的 Haiku 版本" },
];

const CODEX_LOGGED_OUT = "Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）";

/**
 * Claude Code's「思考等级」is the harness `thinking` setting
 * (`ClaudeCodeHarnessSettings.thinking`), not a per-model capability, so every
 * entry in that catalog offers the same three.
 */
const CLAUDE_CODE_REASONING_LEVELS = ["disabled", "adaptive", "enabled"];
const CLAUDE_CODE_DEFAULT_REASONING_LEVEL = "adaptive";

/**
 * What `@ai-sdk/openai` documents for a gateway-routed OpenAI model. Only
 * `openai/*` gets these: no other provider on the gateway shares the option,
 * and inventing levels for one would make the picker lie.
 */
const GATEWAY_OPENAI_REASONING_LEVELS = ["low", "medium", "high"];
const GATEWAY_OPENAI_DEFAULT_REASONING_LEVEL = "medium";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stamps the harness's three thinking levels onto every Claude Code entry. */
function withClaudeCodeReasoning(entries: readonly ModelEntry[]): ModelEntry[] {
  return entries.map((entry) => ({
    ...entry,
    reasoningLevels: [...CLAUDE_CODE_REASONING_LEVELS],
    defaultReasoningLevel: CLAUDE_CODE_DEFAULT_REASONING_LEVEL,
  }));
}

/**
 * The level ids out of a row's `supported_reasoning_levels`. The live Codex
 * backend and the CLI's cache both spell each level as an object —
 * `{ effort: "low", description: "…" }` — so only the `effort` is kept; a bare
 * string is accepted too, since that is the cheaper shape to write in a test
 * and costs nothing to support.
 */
function asReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .map((item) => (typeof item === "string" ? item : isRecord(item) && typeof item.effort === "string" ? item.effort : ""))
    .filter((level) => level !== "");
  return levels.length > 0 ? levels : undefined;
}

/** The reasoning levels a Codex catalog row declares, in the order it lists them. */
function codexReasoning(entry: CodexCatalogModel): ReasoningLevels {
  const levels = entry.supported_reasoning_levels;
  if (levels == null || levels.length === 0) return {};
  return {
    reasoningLevels: [...levels],
    ...(entry.default_reasoning_level != null && levels.includes(entry.default_reasoning_level)
      ? { defaultReasoningLevel: entry.default_reasoning_level }
      : {}),
  };
}

/** Mirrors `resolveCodexHome` in `@vgent/providers`, which does not export it. */
function codexHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.CODEX_HOME ?? join(homedir(), ".codex"));
}

/** Keeps the listable models, newest-first by Codex's own `priority`. */
function normalizeCodexModels(raw: readonly unknown[]): CodexCatalogModel[] {
  return raw
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.slug === "string")
    .filter((entry) => entry.visibility === "list")
    .map((entry) => {
      const levels = asReasoningLevels(entry.supported_reasoning_levels);
      return {
        slug: entry.slug as string,
        ...(typeof entry.display_name === "string" ? { display_name: entry.display_name } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.priority === "number" ? { priority: entry.priority } : {}),
        ...(typeof entry.context_window === "number" ? { context_window: entry.context_window } : {}),
        ...(levels != null ? { supported_reasoning_levels: levels } : {}),
        ...(typeof entry.default_reasoning_level === "string" && entry.default_reasoning_level !== ""
          ? { default_reasoning_level: entry.default_reasoning_level }
          : {}),
      };
    })
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
}

/**
 * The catalog the installed Codex CLI last fetched. Read-only on purpose:
 * `~/.codex` belongs to that CLI and this server never writes its cache back.
 */
async function readCodexCache(
  home: string,
): Promise<{ clientVersion?: string; models: CodexCatalogModel[] } | undefined> {
  const text = await readFile(join(home, "models_cache.json"), "utf8").catch(() => undefined);
  if (text == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  return {
    ...(typeof parsed.client_version === "string" ? { clientVersion: parsed.client_version } : {}),
    models: normalizeCodexModels(parsed.models),
  };
}

/**
 * `GET https://chatgpt.com/backend-api/codex/models?client_version=<ver>` — the
 * endpoint the Codex CLI's `models-manager` fills `models_cache.json` from,
 * confirmed against the installed binary and by a live 200 whose ETag matched
 * the cached one. `createCodexFetch` refuses to send the subscription token
 * anywhere but this origin and path prefix.
 */
async function fetchCodexRemoteCatalog(
  input: { clientVersion: string; signal: AbortSignal },
  env: NodeJS.ProcessEnv,
): Promise<CodexCatalogModel[]> {
  const codexFetch = createCodexFetch({ tokens: new CodexTokenProvider({ env }) });
  const url = `${CHATGPT_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(input.clientVersion)}`;
  const response = await codexFetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Codex 模型目录返回 ${response.status}`);
  const body: unknown = await response.json();
  return isRecord(body) && Array.isArray(body.models) ? normalizeCodexModels(body.models) : [];
}

/** `GET /v1/models` on the public Anthropic API — only ever with an API key. */
async function fetchAnthropicModels(apiKey: string, signal: AbortSignal): Promise<ModelEntry[]> {
  const response = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    signal,
  });
  if (!response.ok) throw new Error(`Anthropic 模型接口返回 ${response.status}`);
  const body: unknown = await response.json();
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return data
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.id === "string")
    .map((entry) => ({
      id: entry.id as string,
      label: typeof entry.display_name === "string" ? entry.display_name : (entry.id as string),
    }));
}

/**
 * Per-engine model lists for the picker.
 *
 * Every source is best-effort: a remote call that fails falls through to the
 * next one and leaves a `warning` on the catalog instead of failing the request,
 * because a picker with a stale list still works and one with an error does not.
 */
export function createModelCatalog(options: ModelCatalogOptions = {}): ModelCatalogService {
  const log = options.log ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const gateway = options.gateway ?? defaultGateway;
  const fetchCodexRemote = options.fetchCodexRemote ?? ((input) => fetchCodexRemoteCatalog(input, env));

  const cached = new Map<EngineId, { at: number; catalog: ModelCatalog }>();

  /** Codex's own catalog, shared by the `codex` and `vgent` engines. */
  const listCodexModels = async (): Promise<{ models: CodexCatalogModel[]; source: string; warning?: string }> => {
    const report = await describeSubscriptionAuth({ env });
    if (!report.codex.available) return { models: [], source: "builtin", warning: CODEX_LOGGED_OUT };

    const cache = await readCodexCache(codexHome(env));
    let warning: string | undefined;
    try {
      const remote = await fetchCodexRemote({
        clientVersion: cache?.clientVersion ?? FALLBACK_CODEX_CLIENT_VERSION,
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      });
      if (remote.length > 0) return { models: remote, source: "codex-remote" };
      warning = "Codex 在线目录没有返回模型，已改用本地缓存";
    } catch (error) {
      log.warn("拉取 Codex 在线模型目录失败，改用本地缓存", error);
      warning = "Codex 在线目录不可用，已改用本地缓存";
    }

    if (cache != null && cache.models.length > 0) return { models: cache.models, source: "codex-cache", warning };
    return { models: [], source: "builtin", warning: "找不到 Codex 模型目录，已改用内置清单" };
  };

  const listGatewayModels = async (): Promise<{ models: ModelEntry[]; warning?: string }> => {
    if (!GATEWAY_ENV_VARS.some((name) => (env[name] ?? "") !== "")) return { models: [] };
    try {
      const { models } = await gateway.getAvailableModels();
      return {
        models: models
          .filter((entry) => entry.modelType == null || entry.modelType === "language")
          .map((entry) => ({
            id: entry.id,
            label: entry.name ?? entry.id,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(entry.id.startsWith("openai/")
              ? {
                  reasoningLevels: [...GATEWAY_OPENAI_REASONING_LEVELS],
                  defaultReasoningLevel: GATEWAY_OPENAI_DEFAULT_REASONING_LEVEL,
                }
              : {}),
          })),
      };
    } catch (error) {
      log.warn("拉取 AI Gateway 模型列表失败", error);
      return { models: [], warning: "AI Gateway 模型列表不可用" };
    }
  };

  const buildCodex = async (): Promise<Omit<ModelCatalog, "engine" | "fetchedAt">> => {
    const codex = await listCodexModels();
    if (codex.models.length === 0) {
      return { models: CODEX_BUILTIN, source: "builtin", ...(codex.warning != null ? { warning: codex.warning } : {}) };
    }
    return {
      models: codex.models.map((entry) => ({
        id: entry.slug,
        label: entry.display_name ?? entry.slug,
        ...(entry.description != null ? { description: entry.description } : {}),
        ...codexReasoning(entry),
        ...(entry.context_window != null ? { contextWindow: entry.context_window } : {}),
      })),
      source: codex.source,
      ...(codex.warning != null ? { warning: codex.warning } : {}),
    };
  };

  const buildVgent = async (): Promise<Omit<ModelCatalog, "engine" | "fetchedAt">> => {
    const [codex, gatewayModels] = await Promise.all([listCodexModels(), listGatewayModels()]);
    const models: ModelEntry[] = [];
    const sources: string[] = [];
    const warnings = [codex.warning, gatewayModels.warning].filter((value): value is string => value != null);

    if (codex.models.length > 0) {
      sources.push(codex.source);
      models.push(
        ...codex.models.map((entry) => ({
          id: `${CODEX_SUBSCRIPTION_PREFIX}${entry.slug}`,
          label: `${CODEX_SUBSCRIPTION_PREFIX}${entry.slug}`,
          ...(entry.display_name != null ? { description: entry.display_name } : {}),
          // Same model behind the subscription prefix, so the same levels and
          // the same window apply.
          ...codexReasoning(entry),
          ...(entry.context_window != null ? { contextWindow: entry.context_window } : {}),
        })),
      );
    }
    if (gatewayModels.models.length > 0) {
      sources.push("gateway");
      models.push(...gatewayModels.models);
    }
    if (models.length === 0) {
      return { models: VGENT_BUILTIN, source: "builtin", ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}) };
    }
    return { models, source: sources.join("+"), ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}) };
  };

  const buildClaudeCode = async (): Promise<Omit<ModelCatalog, "engine" | "fetchedAt">> => {
    const builtin = withClaudeCodeReasoning(CLAUDE_CODE_BUILTIN);
    const apiKey = env.ANTHROPIC_API_KEY ?? "";
    if (apiKey === "") return { models: builtin, source: "builtin" };
    try {
      const listed = await fetchAnthropicModels(apiKey, AbortSignal.timeout(REMOTE_TIMEOUT_MS));
      if (listed.length > 0) return { models: [...builtin, ...withClaudeCodeReasoning(listed)], source: "anthropic-api" };
      return { models: builtin, source: "builtin" };
    } catch (error) {
      log.warn("拉取 Anthropic 模型列表失败", error);
      return { models: builtin, source: "builtin", warning: "Anthropic 模型接口不可用，已改用内置别名" };
    }
  };

  const build = async (engine: EngineId): Promise<ModelCatalog> => {
    const partial =
      engine === "codex" ? await buildCodex() : engine === "vgent" ? await buildVgent() : await buildClaudeCode();
    return { engine, fetchedAt: new Date(now()).toISOString(), ...partial };
  };

  return {
    async list(engine, listOptions) {
      const hit = cached.get(engine);
      if (listOptions?.refresh !== true && hit != null && now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
      const catalog = await build(engine);
      cached.set(engine, { at: now(), catalog });
      return catalog;
    },
  };
}
