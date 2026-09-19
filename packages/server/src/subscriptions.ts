import { execFile } from "node:child_process";
import { CODEX_SUBSCRIPTION_PREFIX } from "@vgent/engine";
import { describeSubscriptionAuth } from "@vgent/providers";
import type { ModelCatalogService, ModelEntry } from "./models.js";
import type { EngineId, Settings } from "./types.js";

/**
 * 订阅: the two logins an agent can run on without a key. They sit on the
 * settings page next to the connected providers, because to the user they are
 * the same thing — an account that brings models — with one difference: they are
 * signed in to with the vendor's own CLI, not here, and we never hold a token.
 */
export type SubscriptionId = "claude-subscription" | "codex-subscription";

export const SUBSCRIPTION_IDS: readonly SubscriptionId[] = ["claude-subscription", "codex-subscription"];

/** One model of a subscription: a row of the 模型 table. */
export interface SubscriptionModel {
  id: string;
  label: string;
  description?: string;
  contextWindow?: number;
  /** Per agent that can run it: the id a task's `model` takes there, and whether that agent's picker offers it. */
  agents: Partial<Record<EngineId, { spec: string; enabled: boolean }>>;
}

export interface SubscriptionAccount {
  id: SubscriptionId;
  name: string;
  /** Absent when nobody can say: the CLI that knows is not installed. */
  loggedIn?: boolean;
  email?: string;
  plan?: string;
  /** How it is signed in when that is not the subscription itself (an API key, a cloud account). */
  method?: string;
  /** What to run in a terminal to sign in. There is no key to paste. */
  loginCommand: string;
  /** The agents that run on this login, in the order the table shows them. */
  agents: EngineId[];
  /** Why an agent one would expect is missing from `agents`. */
  note?: string;
  /** Why the model list is not the live one. */
  warning?: string;
  models: SubscriptionModel[];
}

/** What `claude auth status --json` says. Every field optional: an older CLI says less. */
export interface ClaudeLoginStatus {
  loggedIn?: boolean;
  email?: string;
  plan?: string;
  method?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the status JSON whatever the exit code was: a CLI that is signed out may well exit non-zero and still answer. */
export function parseClaudeLoginStatus(stdout: string): ClaudeLoginStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") return {};
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const method = text(parsed.authMethod);
  return {
    loggedIn: parsed.loggedIn,
    ...(text(parsed.email) != null ? { email: text(parsed.email)! } : {}),
    ...(text(parsed.subscriptionType) != null ? { plan: text(parsed.subscriptionType)! } : {}),
    // `claude.ai` is the subscription; anything else is worth a word, because the models and the bill differ.
    ...(parsed.loggedIn && method != null && method !== "claude.ai" ? { method } : {}),
  };
}

/**
 * Asks the `claude` CLI on PATH. That is the same login the Claude Code harness
 * runs on (its bridge reads `~/.claude` and the keychain the way the CLI does),
 * and asking the CLI keeps this process out of Anthropic's credentials entirely.
 */
export function probeClaudeLogin(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeLoginStatus> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status", "--json"], { env, timeout: 8_000, encoding: "utf8" }, (_error, stdout) => {
      resolve(parseClaudeLoginStatus(typeof stdout === "string" ? stdout : ""));
    });
  });
}

/** `hiddenModels` with one switch flipped for some of an agent's models. */
export function withHiddenModels(
  hidden: Settings["hiddenModels"],
  engine: EngineId,
  specs: readonly string[],
  enabled: boolean,
): NonNullable<Settings["hiddenModels"]> {
  const current = hidden?.[engine] ?? [];
  const next = enabled ? current.filter((spec) => !specs.includes(spec)) : [...new Set([...current, ...specs])];
  return { ...hidden, [engine]: next };
}

/** Stamps `hidden` on what the user switched off. Only an agent's own models: a provider's are on because they were ticked. */
export function markHidden(models: readonly ModelEntry[], hidden: readonly string[] | undefined): ModelEntry[] {
  if (hidden == null || hidden.length === 0) return [...models];
  return models.map((model) => (model.provider == null && hidden.includes(model.id) ? { ...model, hidden: true } : model));
}

export interface SubscriptionService {
  /** Both accounts, with their login state. `refresh` asks the vendors for their model lists again. */
  list(settings: Settings, options?: { refresh?: boolean }): Promise<SubscriptionAccount[]>;
  /** One account's model rows only — what a switch needs back, without asking any CLI again. */
  models(id: SubscriptionId, settings: Settings): Promise<SubscriptionModel[]>;
}

export function createSubscriptionService(options: {
  modelCatalog: ModelCatalogService;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production asks the `claude` CLI. */
  probeClaude?: () => Promise<ClaudeLoginStatus>;
}): SubscriptionService {
  const env = options.env ?? process.env;
  const probeClaude = options.probeClaude ?? (() => probeClaudeLogin(env));
  const { modelCatalog } = options;

  const row = (entry: ModelEntry, id: string): Omit<SubscriptionModel, "agents"> => ({
    id,
    label: entry.label,
    ...(entry.description != null ? { description: entry.description } : {}),
    ...(entry.contextWindow != null ? { contextWindow: entry.contextWindow } : {}),
  });
  const cell = (settings: Settings, engine: EngineId, spec: string) => ({ spec, enabled: !(settings.hiddenModels?.[engine] ?? []).includes(spec) });

  const claudeModels = async (settings: Settings, refresh: boolean): Promise<{ models: SubscriptionModel[]; warning?: string }> => {
    const catalog = await modelCatalog.list("claude-code", { refresh });
    return {
      models: catalog.models.map((entry) => ({ ...row(entry, entry.id), agents: { "claude-code": cell(settings, "claude-code", entry.id) } })),
      ...(catalog.warning != null ? { warning: catalog.warning } : {}),
    };
  };

  // One row per Codex model, whichever agent lists it: the Codex agent calls it
  // by its slug, the in-house one by the slug behind the subscription prefix.
  const codexModels = async (settings: Settings, refresh: boolean): Promise<{ models: SubscriptionModel[]; warning?: string }> => {
    const [codex, vgent] = await Promise.all([modelCatalog.list("codex", { refresh }), modelCatalog.list("vgent", { refresh })]);
    const rows = new Map<string, SubscriptionModel>();
    for (const entry of vgent.models) {
      if (!entry.id.startsWith(CODEX_SUBSCRIPTION_PREFIX)) continue;
      const slug = entry.id.slice(CODEX_SUBSCRIPTION_PREFIX.length);
      rows.set(slug, { ...row(entry, slug), agents: { vgent: cell(settings, "vgent", entry.id) } });
    }
    for (const entry of codex.models) {
      const existing = rows.get(entry.id) ?? { ...row(entry, entry.id), agents: {} };
      rows.set(entry.id, { ...existing, agents: { ...existing.agents, codex: cell(settings, "codex", entry.id) } });
    }
    return { models: [...rows.values()], ...(codex.warning != null ? { warning: codex.warning } : {}) };
  };

  return {
    async list(settings, listOptions) {
      const refresh = listOptions?.refresh === true;
      const [claudeLogin, codexLogin, claude, codex] = await Promise.all([
        probeClaude().catch((): ClaudeLoginStatus => ({})),
        describeSubscriptionAuth({ env }),
        claudeModels(settings, refresh),
        codexModels(settings, refresh),
      ]);
      return [
        {
          id: "claude-subscription",
          name: "Claude 订阅",
          ...claudeLogin,
          loginCommand: "claude auth login",
          agents: ["claude-code"],
          note: "只有 Claude Code 能用：Anthropic 的条款把这个登录限定在 Claude Code 里，所以自研 agent 不拿它调模型。",
          ...claude,
        },
        {
          id: "codex-subscription",
          name: "ChatGPT · Codex 订阅",
          loggedIn: codexLogin.codex.available,
          ...(codexLogin.codex.email != null ? { email: codexLogin.codex.email } : {}),
          ...(codexLogin.codex.plan != null ? { plan: codexLogin.codex.plan } : {}),
          loginCommand: "codex login",
          agents: ["vgent", "codex"],
          ...codex,
        },
      ];
    },
    async models(id, settings) {
      return (id === "claude-subscription" ? await claudeModels(settings, false) : await codexModels(settings, false)).models;
    },
  };
}
