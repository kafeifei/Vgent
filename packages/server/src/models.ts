import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CODEX_SUBSCRIPTION_PREFIX } from "@vgent/engine";
import { CHATGPT_CODEX_BASE_URL, getCodexTokenProvider, createCodexFetch, describeSubscriptionAuth, type ModelCost } from "@vgent/providers";
import { gateway as defaultGateway } from "ai";
import type { EngineId, Logger } from "./types.js";
import { silentLogger } from "./types.js";
import { CLAUDE_CODE_LONG_CONTEXT } from "./engines/claude-code.js";
import { DEFAULT_REASONING_LEVEL, defaultLevelFor, reasoningFor } from "./reasoning.js";

/** One selectable model. `id` is what a thread's `model` field is set to. */
export interface ModelEntry {
  id: string;
  label: string;
  description?: string;
  /**
   * The display name of the settings-page provider this model comes from. Absent
   * for an engine's own models (its login, its built-in aliases); the picker
   * lists those first and the rest under their provider's name.
   */
  provider?: string;
  /**
   * Switched off in the 模型 table (`Settings.hiddenModels`). The entry still
   * travels — a task already on this model, or an agent whose default it is,
   * needs its label, 思考 levels and window — the picker just does not offer it.
   */
  hidden?: boolean;
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
   * Faster-for-more service tiers this model can be run on, as its own source
   * declares them (Codex's catalog: `{ id: "priority", name: "Fast", … }`).
   * Absent means there is nothing to switch, and the composer shows no toggle.
   */
  serviceTiers?: ServiceTier[];
  /**
   * The model's usable context window in tokens — the denominator of the
   * composer's context ring. Only sources that report one fill it: Codex does
   * (`context_window`), while the Anthropic models API and the AI Gateway list
   * do not, so it stays undefined there and the client falls back to its own
   * default.
   */
  contextWindow?: number;
  /**
   * The windows this model can be run with on this engine, smallest first —
   * present only when there is a choice to make. What the engine itself said
   * (Codex's 272K) next to what the provider catalog lists for the model (1M);
   * for Claude Code, the standard window next to the long one.
   */
  contextOptions?: number[];
  /**
   * The same under every engine that can run this very model — the Codex
   * login's GPT-5.5 is one model whether the Codex CLI or the in-house engine
   * drives it — so the picker can show it once and offer the engine as a choice.
   */
  modelKey?: string;
  /** Whose model it is: what the picker's row icon and its grouping are drawn from. */
  source?: ModelSource;
  /**
   * Who *made* the model, as a provider-catalog id (`openai`, `anthropic`, …) —
   * not who serves it: a company gateway's `codex/gpt-6-astra` is OpenAI's. It
   * decides the engine a model runs on by default (GPT on Codex, Claude on
   * Claude Code, the rest on the in-house engine). Absent when the catalog has
   * never heard of the model.
   */
  vendor?: string;
  /**
   * The maker's list price, from the provider catalog — what the context card
   * prices a task's tokens at. On a subscription nothing is billed per token,
   * so it only ever says what the same work would cost on the API.
   */
  cost?: ModelCost;
}

export interface ModelSource {
  kind: "codex-subscription" | "claude-subscription" | "provider" | "gateway";
  /** The settings-page provider's id, for `provider`. */
  id?: string;
  name: string;
  /**
   * The provider-catalog id whose logo stands for this source (models.dev serves
   * one per provider). Absent for a provider the catalog does not know — a
   * company gateway — which gets its initial instead.
   */
  logo?: string;
  /**
   * Where the user put this source in 提供商排序 (`Settings.providerOrder`).
   * Absent for one they never placed; the picker lists those after the rest.
   */
  rank?: number;
}

/** How `Settings.providerOrder` names a source: a provider by its id, a login by its kind. */
export const sourceOrderKey = (source: ModelSource): string => (source.kind === "provider" ? (source.id ?? source.name) : source.kind);

/**
 * The list regrouped in 提供商排序: each ranked source's models, in the user's
 * order, then the unranked ones as they were. Stable within a source.
 */
export function orderBySource(models: readonly ModelEntry[], order: readonly string[] | undefined): ModelEntry[] {
  if (order == null || order.length === 0) return [...models];
  const ranked = models.map((entry) => {
    const at = entry.source == null ? -1 : order.indexOf(sourceOrderKey(entry.source));
    return at < 0 || entry.source == null ? entry : { ...entry, source: { ...entry.source, rank: at } };
  });
  const rankOf = (entry: ModelEntry) => entry.source?.rank ?? Number.POSITIVE_INFINITY;
  return ranked
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => rankOf(a.entry) - rankOf(b.entry) || a.at - b.at)
    .map(({ entry }) => entry);
}

const CODEX_SOURCE: ModelSource = { kind: "codex-subscription", name: "Codex", logo: "openai" };
const CLAUDE_SOURCE: ModelSource = { kind: "claude-subscription", name: "Claude", logo: "anthropic" };
const GATEWAY_SOURCE: ModelSource = { kind: "gateway", name: "AI Gateway", logo: "vercel" };

/** From here up a window counts as long, and a model that has nothing shorter is offered {@link SHORT_CONTEXT_OPTION} beside it. */
const LONG_CONTEXT = 1_000_000;
const SHORT_CONTEXT_OPTION = 300_000;

/** Claude Code's window when the model name carries no `[1m]`. */
const CLAUDE_CODE_STANDARD_CONTEXT = 200_000;

/**
 * `ModelEntry.contextOptions` out of the two things known about a model's
 * window: what the engine's own source said, and what the provider catalog
 * lists; a model with a single, long window gets a shorter one added. Claude
 * Code is its own case — its choice is standard or long, and long
 * exists only for a model the catalog says can do it.
 */
export function contextOptionsFor(engine: EngineId, own: number | undefined, listed: number | undefined): Pick<ModelEntry, "contextOptions"> {
  if (engine === "claude-code") {
    const long = Math.max(own ?? 0, listed ?? 0);
    return long >= CLAUDE_CODE_LONG_CONTEXT ? { contextOptions: [CLAUDE_CODE_STANDARD_CONTEXT, long] } : {};
  }
  const options = [...new Set([own, listed].filter((value): value is number => value != null))].sort((a, b) => a - b);
  // A model known only by a 1M window still gets a choice (用户 2026-09-20): a
  // long window is slower and dearer to fill, and most tasks never need it.
  const only = options[0];
  if (options.length === 1 && only != null && only >= LONG_CONTEXT) return { contextOptions: [SHORT_CONTEXT_OPTION, only] };
  return options.length > 1 ? { contextOptions: options } : {};
}

/** The two reasoning fields of a `ModelEntry`, as the builders below merge them in. */
export interface ServiceTier {
  /** What goes on the wire: Codex's `service_tier`, the Responses API's `service_tier`. */
  id: string;
  name: string;
  description?: string;
}

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
  invalidate?(): void;
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
  /** The extra speed tiers the row offers, e.g. `[{ id: "priority", name: "Fast" }]`. */
  service_tiers?: ServiceTier[];
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
  /**
   * Anthropic's models as the provider catalog (models.dev) lists them — what
   * Claude Code offers besides its three aliases. Unset, or failing, the list
   * is the aliases alone.
   */
  anthropicModels?: () => Promise<ReadonlyArray<{ id: string; label?: string }>>;
  /**
   * 「目录对这个模型知道什么」— its effort levels, its window — from the provider
   * catalog (`createModelIndex`). Absent — a test, a build with no catalog —
   * every Claude Code model offers the harness's five and nothing has a choice
   * of window.
   */
  catalogModelOf?: () => Promise<(modelId: string) => { reasoningLevels?: string[]; contextWindow?: number; vendor?: string; cost?: ModelCost } | undefined>;
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

/** One key for the Codex login's model, whichever engine names it. */
const codexModelKey = (slug: string): string => `codex-subscription/${slug}`;

const CODEX_BUILTIN: ModelEntry[] = [{ id: "gpt-5.5", label: "gpt-5.5", modelKey: codexModelKey("gpt-5.5"), source: CODEX_SOURCE, vendor: "openai" }];

const VGENT_BUILTIN: ModelEntry[] = [
  { id: `${CODEX_SUBSCRIPTION_PREFIX}gpt-5.5`, label: "gpt-5.5", modelKey: codexModelKey("gpt-5.5"), source: CODEX_SOURCE, vendor: "openai" },
];

/**
 * The Claude Agent SDK has no list endpoint, and the harness passes `model`
 * through verbatim. These three aliases are what it accepts besides a full id
 * (`@ai-sdk/harness-claude-code` types them as `"sonnet" | "opus" | "haiku"`);
 * the full ids come from the provider catalog, see `anthropicModels`.
 */
const CLAUDE_CODE_BUILTIN: ModelEntry[] = [
  { id: "sonnet", label: "sonnet", description: "别名：当前默认的 Sonnet 版本" },
  { id: "opus", label: "opus", description: "别名：当前默认的 Opus 版本" },
  { id: "haiku", label: "haiku", description: "别名：当前默认的 Haiku 版本" },
];

const CODEX_LOGGED_OUT = "Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）";

/**
 * What `@ai-sdk/openai` documents for a gateway-routed OpenAI model. Only
 * `openai/*` gets these: no other provider on the gateway shares the option,
 * and inventing levels for one would make the picker lie.
 */
const GATEWAY_OPENAI_REASONING_LEVELS = ["low", "medium", "high"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 推理强度 for every Claude Code entry. `effort` is a harness setting, but what
 * a model does with it is the model's: Opus 4.5 stops at 高, Haiku has no knob.
 * So each entry offers what the catalog lists for it, and an alias (`opus`)
 * what the newest model of that family lists — `newestFirst` is the catalog's
 * Anthropic list, which is in that order.
 */
function withClaudeCodeReasoning(
  entries: readonly ModelEntry[],
  modelOf: ((modelId: string) => { reasoningLevels?: string[]; contextWindow?: number; cost?: ModelCost } | undefined) | undefined,
  newestFirst: readonly ModelEntry[],
): ModelEntry[] {
  const known = (entry: ModelEntry) => {
    if (modelOf == null) return undefined;
    const direct = modelOf(entry.id);
    if (direct != null) return direct;
    const family = newestFirst.find((candidate) => candidate.id.startsWith(`claude-${entry.id}-`));
    return family == null ? undefined : modelOf(family.id);
  };
  return entries.map((entry) => {
    const listed = known(entry);
    return {
      ...entry,
      modelKey: `claude-subscription/${entry.id}`,
      source: CLAUDE_SOURCE,
      vendor: "anthropic",
      ...reasoningFor("claude-code", listed?.reasoningLevels),
      ...contextOptionsFor("claude-code", undefined, listed?.contextWindow),
      // An alias is priced as the model it resolves to today.
      ...(listed?.cost != null ? { cost: listed.cost } : {}),
    };
  });
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

/** A row's `service_tiers`, keeping only entries that carry both an id and a name. */
function asServiceTiers(value: unknown): ServiceTier[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers = value.flatMap((item): ServiceTier[] =>
    isRecord(item) && typeof item.id === "string" && item.id !== "" && typeof item.name === "string" && item.name !== ""
      ? [{ id: item.id, name: item.name, ...(typeof item.description === "string" ? { description: item.description } : {}) }]
      : [],
  );
  return tiers.length > 0 ? tiers : undefined;
}

/** The service tiers a Codex catalog row declares, as the model entry carries them. */
const codexTiers = (entry: CodexCatalogModel): Pick<ModelEntry, "serviceTiers"> =>
  entry.service_tiers != null && entry.service_tiers.length > 0 ? { serviceTiers: entry.service_tiers } : {};

/** The reasoning levels a Codex catalog row declares, in the order it lists them. */
function codexReasoning(entry: CodexCatalogModel): ReasoningLevels {
  const levels = entry.supported_reasoning_levels;
  if (levels == null || levels.length === 0) return {};
  return {
    reasoningLevels: [...levels],
    ...(defaultLevelFor(levels, entry.default_reasoning_level) != null
      ? { defaultReasoningLevel: defaultLevelFor(levels, entry.default_reasoning_level) as string }
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
      const tiers = asServiceTiers(entry.service_tiers);
      return {
        slug: entry.slug as string,
        ...(typeof entry.display_name === "string" ? { display_name: entry.display_name } : {}),
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(typeof entry.priority === "number" ? { priority: entry.priority } : {}),
        ...(typeof entry.context_window === "number" ? { context_window: entry.context_window } : {}),
        ...(levels != null ? { supported_reasoning_levels: levels } : {}),
        ...(tiers != null ? { service_tiers: tiers } : {}),
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
  const codexFetch = createCodexFetch({ tokens: getCodexTokenProvider({ env }) });
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
  let revision = 0;

  /** Best-effort like every other source: no catalog means no levels and no choice of window, not a failed list. */
  const catalogModelOf = async () =>
    options.catalogModelOf?.().catch((error: unknown) => {
      log.warn("读取提供商目录失败", error);
      return undefined;
    });

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
            modelKey: `gateway/${entry.id}`,
            source: GATEWAY_SOURCE,
            ...(typeof entry.description === "string" ? { description: entry.description } : {}),
            ...(entry.id.startsWith("openai/")
              ? {
                  reasoningLevels: [...GATEWAY_OPENAI_REASONING_LEVELS],
                  defaultReasoningLevel: DEFAULT_REASONING_LEVEL,
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
    const [codex, modelOf] = await Promise.all([listCodexModels(), catalogModelOf()]);
    if (codex.models.length === 0) {
      return { models: CODEX_BUILTIN, source: "builtin", ...(codex.warning != null ? { warning: codex.warning } : {}) };
    }
    return {
      models: codex.models.map((entry) => ({
        id: entry.slug,
        label: entry.display_name ?? entry.slug,
        ...(entry.description != null ? { description: entry.description } : {}),
        ...codexReasoning(entry),
        ...codexTiers(entry),
        ...(entry.context_window != null ? { contextWindow: entry.context_window } : {}),
        ...contextOptionsFor("codex", entry.context_window, modelOf?.(entry.slug)?.contextWindow),
        modelKey: codexModelKey(entry.slug),
        source: CODEX_SOURCE,
        vendor: "openai",
      })),
      source: codex.source,
      ...(codex.warning != null ? { warning: codex.warning } : {}),
    };
  };

  const buildVgent = async (): Promise<Omit<ModelCatalog, "engine" | "fetchedAt">> => {
    const [codex, gatewayModels, modelOf] = await Promise.all([listCodexModels(), listGatewayModels(), catalogModelOf()]);
    const models: ModelEntry[] = [];
    const sources: string[] = [];
    const warnings = [codex.warning, gatewayModels.warning].filter((value): value is string => value != null);

    if (codex.models.length > 0) {
      sources.push(codex.source);
      models.push(
        ...codex.models.map((entry) => ({
          id: `${CODEX_SUBSCRIPTION_PREFIX}${entry.slug}`,
          // The same model as the Codex engine's row, so it is called the same
          // thing; the prefixed id is an implementation detail of the route, and
          // the group heading already says which engine this is.
          label: entry.display_name ?? entry.slug,
          ...(entry.description != null ? { description: entry.description } : {}),
          // Same model behind the subscription prefix, so the same levels and
          // the same window apply.
          ...codexReasoning(entry),
          ...codexTiers(entry),
          ...(entry.context_window != null ? { contextWindow: entry.context_window } : {}),
          ...contextOptionsFor("vgent", entry.context_window, modelOf?.(entry.slug)?.contextWindow),
          modelKey: codexModelKey(entry.slug),
          source: CODEX_SOURCE,
          vendor: "openai",
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

  /**
   * The catalog's Anthropic models, by full id (`claude` takes them on a
   * subscription login as well as on a key — checked against the CLI). Their
   * context window is left out on purpose: the catalog states what the API can
   * do (1M for several), while the window Claude Code actually runs with is its
   * own business, and a ring measured against the wrong one would lie.
   */
  const listAnthropicCatalog = async (): Promise<ModelEntry[]> => {
    if (options.anthropicModels == null) return [];
    try {
      return (await options.anthropicModels()).map((entry) => ({ id: entry.id, label: entry.label ?? entry.id }));
    } catch (error) {
      log.warn("读取提供商目录里的 Anthropic 模型失败", error);
      return [];
    }
  };

  const buildClaudeCode = async (): Promise<Omit<ModelCatalog, "engine" | "fetchedAt">> => {
    const apiKey = env.ANTHROPIC_API_KEY ?? "";
    let warning: string | undefined;
    const modelOf = await catalogModelOf();
    const [fromCatalog, fromApi] = await Promise.all([
      listAnthropicCatalog(),
      apiKey === ""
        ? Promise.resolve<ModelEntry[]>([])
        : fetchAnthropicModels(apiKey, AbortSignal.timeout(REMOTE_TIMEOUT_MS)).catch((error: unknown) => {
            log.warn("拉取 Anthropic 模型列表失败", error);
            warning = "Anthropic 模型接口不可用";
            return [];
          }),
    ]);
    // The aliases first (what「默认」resolves among), then every full id once:
    // the account's own listing wins over the catalog's word for the same model.
    const seen = new Set(CLAUDE_CODE_BUILTIN.map((entry) => entry.id));
    const full = [...fromApi, ...fromCatalog].filter((entry) => !seen.has(entry.id) && seen.add(entry.id) != null);
    const sources = ["builtin", ...(fromApi.length > 0 ? ["anthropic-api"] : []), ...(fromCatalog.length > 0 ? ["models.dev"] : [])];
    return {
      models: withClaudeCodeReasoning([...CLAUDE_CODE_BUILTIN, ...full], modelOf, fromCatalog),
      source: sources.join("+"),
      ...(warning != null ? { warning } : {}),
    };
  };

  const build = async (engine: EngineId): Promise<ModelCatalog> => {
    const partial =
      engine === "codex" ? await buildCodex() : engine === "vgent" ? await buildVgent() : await buildClaudeCode();
    return { engine, fetchedAt: new Date(now()).toISOString(), ...partial };
  };

  return {
    invalidate() { revision++; cached.clear(); },
    async list(engine, listOptions) {
      const generation = revision;
      const hit = cached.get(engine);
      if (listOptions?.refresh !== true && hit != null && now() - hit.at < CATALOG_TTL_MS) return hit.catalog;
      const catalog = await build(engine);
      if (generation === revision) cached.set(engine, { at: now(), catalog });
      return catalog;
    },
  };
}
