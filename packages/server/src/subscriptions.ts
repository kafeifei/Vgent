import { execFile } from "node:child_process";
import { claudeCommand, claudeLoginEnv } from "./claude-login.js";
import { CODEX_SUBSCRIPTION_PREFIX } from "@vgent/engine";
import type { ModelCatalogService, ModelEntry } from "./models.js";
import type { EngineId, Settings } from "./types.js";
import type { createAccountService } from "./accounts/service.js";

/**
 * 订阅: the shared platform logins an Engine can run on without a key. They sit on the
 * settings page next to the connected providers, because to the user they are
 * the same thing — an account that brings models. Identity always comes from
 * the shared account service; this layer only projects model visibility.
 */
export type NativeSubscriptionId = "claude-subscription" | "codex-subscription";
export type SubscriptionId = NativeSubscriptionId | "github-copilot";

export const SUBSCRIPTION_IDS: readonly SubscriptionId[] = ["claude-subscription", "codex-subscription", "github-copilot"];

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
  username?: string;
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
 * Asks the harness CLI, falling back to `claude` on PATH. That is the same login the Claude Code harness
 * runs on (its bridge reads `~/.claude` and the keychain the way the CLI does),
 * and asking the CLI keeps this process out of Anthropic's credentials entirely.
 */
export async function probeClaudeLogin(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeLoginStatus> {
  const command = await claudeCommand();
  return new Promise((resolve) => {
    execFile(command, ["auth", "status", "--json"], { env: claudeLoginEnv(env), timeout: 8_000, encoding: "utf8" }, (_error, stdout) => {
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
  /** All accounts, with their login state. `refresh` asks the vendors for their model lists again. */
  list(settings: Settings, options?: { refresh?: boolean }): Promise<SubscriptionAccount[]>;
  /** One account's model rows only — what a switch needs back, without asking any CLI again. */
  models(id: SubscriptionId, settings: Settings): Promise<SubscriptionModel[]>;
}

export function createSubscriptionService(options: {
  modelCatalog: ModelCatalogService;
  /** Uses the same identities and Copilot catalog as quota, remote access and execution. */
  accounts: Pick<ReturnType<typeof createAccountService>, "list" | "copilot">;
}): SubscriptionService {
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

  const copilotModels = async (settings: Settings, refresh: boolean): Promise<{ models: SubscriptionModel[]; warning?: string }> => {
    try {
      const entries = await options.accounts.copilot.models(refresh);
      return { models: entries.map(entry => ({ ...row(entry, entry.id.slice("github-copilot:".length)), agents: { vgent: cell(settings, "vgent", entry.id) } })) };
    } catch {
      return { models: [], warning: "暂时无法读取 Copilot 模型，请确认此 GitHub 账号具有 Copilot 权限后重试。" };
    }
  };

  return {
    async list(settings, listOptions) {
      const refresh = listOptions?.refresh === true;
      const [identity, claude, codex] = await Promise.all([
        options.accounts.list({ refresh }),
        claudeModels(settings, refresh),
        codexModels(settings, refresh),
      ]);
      const claudeLogin = identity.accounts.find(a => a.id === "claude");
      const codexLogin = identity.accounts.find(a => a.id === "codex");
      const github = identity.accounts.find(a => a.id === "github");
      const login = (account: typeof claudeLogin) => ({
        ...(account?.loggedIn != null ? { loggedIn: account.loggedIn } : {}),
        ...(account?.email ? { email: account.email } : {}),
        ...(account?.plan ? { plan: account.plan } : {}),
        ...(account?.method ? { method: account.method } : {}),
      });
      return [
        {
          id: "claude-subscription",
          name: "Claude 订阅",
          ...login(claudeLogin),
          loginCommand: "claude auth login",
          agents: ["claude-code"],
          note: "当前登录由 Claude Code 引擎使用。",
          ...claude,
        },
        {
          id: "codex-subscription",
          name: "ChatGPT · Codex 订阅",
          ...login(codexLogin),
          loginCommand: "codex login",
          agents: ["vgent", "codex"],
          ...codex,
        },
        ...(github ? [{
          id: "github-copilot" as const,
          name: "GitHub Copilot",
          ...login(github),
          ...(github.username ? { username: github.username } : {}),
          loginCommand: "",
          agents: ["vgent" as const],
          note: "与远程访问共用 GitHub 登录；模型开关决定 Vgent 引擎选择器中显示哪些模型。",
          ...(github.loggedIn ? await copilotModels(settings, refresh) : { models: [] }),
        }] : []),
      ];
    },
    async models(id, settings) {
      return (id === "github-copilot" ? await copilotModels(settings, false) : id === "claude-subscription" ? await claudeModels(settings, false) : await codexModels(settings, false)).models;
    },
  };
}
