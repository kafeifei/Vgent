import { execFile } from "node:child_process";
import { claudeCommand, claudeLoginEnv } from "./claude-login.js";
import { CODEX_SUBSCRIPTION_PREFIX } from "@vgent/engine";
import { accountSourceName, type ModelCatalogService, type ModelEntry } from "./models.js";
import type { EngineId, Settings } from "./types.js";
import type { AccountService } from "./accounts/service.js";
import { accountOfSubscriptionKey, splitAccountSpec, subscriptionKey } from "./accounts/spec.js";
import type { AccountId, AccountKind, AccountSummary } from "./accounts/types.js";

/**
 * 订阅: the accounts an Engine can run on without a key. Each one that brings
 * models — a Claude or Codex login, a GitHub account's Copilot — is a row of
 * the provider page of its own, next to the connected providers, because to
 * the user it is the same thing: an account that brings models. Who is signed
 * in comes from the account service; this layer only projects model switches.
 */

/** What a subscription is called in 提供商排序 and on the provider page: see `subscriptionKey`. */
export type SubscriptionId = string;

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
  /** The account behind it, for 管理账号. */
  accountId: AccountId;
  kind: AccountKind;
  /** The platform, then who is signed in: the model picker's heading for these models. */
  name: string;
  email?: string;
  username?: string;
  plan?: string;
  /** How it is signed in when that is not the subscription itself (an API key, a cloud account). */
  method?: string;
  /** The agents this account is switched on for, in the order the table shows them. */
  agents: EngineId[];
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
  /** Which organization the login is in: with the email, what tells two logins apart. */
  orgId?: string;
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
    ...(text(parsed.orgId) != null ? { orgId: text(parsed.orgId)! } : {}),
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
  /** Every signed-in account with a model use on. `refresh` asks the vendors for their model lists again. */
  list(settings: Settings, options?: { refresh?: boolean }): Promise<SubscriptionAccount[]>;
  /** One account's model rows only — what a switch needs back, without asking any CLI again. Undefined for no such subscription. */
  models(id: SubscriptionId, settings: Settings): Promise<SubscriptionModel[] | undefined>;
}

/** The engines each platform's models run on, in the table's column order. */
const ENGINES: Record<AccountKind, EngineId[]> = {
  claude: ["claude-code"],
  codex: ["vgent", "codex", "opencode"],
  github: ["vgent"],
};

/** The model a row stands for, whichever engine names it: its id without the account and the subscription prefix. */
function rowId(spec: string): string {
  const bare = splitAccountSpec(spec).spec;
  if (bare.startsWith(CODEX_SUBSCRIPTION_PREFIX)) return bare.slice(CODEX_SUBSCRIPTION_PREFIX.length);
  if (bare.startsWith("github-copilot:")) return bare.slice("github-copilot:".length);
  return bare;
}

export function createSubscriptionService(options: {
  modelCatalog: ModelCatalogService;
  accounts: Pick<AccountService, "list" | "copilotModels">;
}): SubscriptionService {
  const { modelCatalog } = options;

  /** Engines this account's models run on right now: switched on, and the engine lists them. */
  const agentsOf = (account: AccountSummary): EngineId[] =>
    account.uses.some((entry) => entry.id === "models" && entry.enabled) ? ENGINES[account.kind] : [];

  const rows = async (account: AccountSummary, settings: Settings, refresh: boolean): Promise<{ models: SubscriptionModel[]; warning?: string }> => {
    const agents = agentsOf(account);
    const byRow = new Map<string, SubscriptionModel>();
    let warning: string | undefined;
    for (const engine of agents) {
      let entries: ModelEntry[];
      if (account.kind === "github") {
        entries = await options.accounts.copilotModels(refresh);
        if (!entries.some((entry) => entry.source?.account === account.id)) warning = "暂时无法读取 Copilot 模型，请确认此 GitHub 账号具有 Copilot 权限后重试。";
      } else {
        const catalog = await modelCatalog.list(engine, { refresh });
        entries = catalog.models;
        warning ??= catalog.warning;
      }
      for (const entry of entries) {
        if (entry.source?.account !== account.id) continue;
        const id = rowId(entry.id);
        const existing = byRow.get(id) ?? {
          id,
          label: entry.label,
          ...(entry.description != null ? { description: entry.description } : {}),
          ...(entry.contextWindow != null ? { contextWindow: entry.contextWindow } : {}),
          agents: {},
        };
        existing.agents[engine] = { spec: entry.id, enabled: !(settings.hiddenModels?.[engine] ?? []).includes(entry.id) };
        byRow.set(id, existing);
      }
    }
    return { models: [...byRow.values()], ...(warning != null ? { warning } : {}) };
  };

  const subscriptionOf = async (account: AccountSummary, settings: Settings, refresh: boolean): Promise<SubscriptionAccount> => ({
    id: subscriptionKey(account.id),
    accountId: account.id,
    kind: account.kind,
    name: accountSourceName(account.kind === "github" ? "GitHub Copilot" : account.name, account),
    ...(account.email != null ? { email: account.email } : {}),
    ...(account.username != null ? { username: account.username } : {}),
    ...(account.plan != null ? { plan: account.plan } : {}),
    ...(account.method != null ? { method: account.method } : {}),
    agents: agentsOf(account),
    ...(await rows(account, settings, refresh)),
  });

  const withModels = (account: AccountSummary) => account.loggedIn === true && agentsOf(account).length > 0;

  return {
    async list(settings, listOptions) {
      const refresh = listOptions?.refresh === true;
      const accounts = (await options.accounts.list({ refresh })).accounts.filter(withModels);
      return Promise.all(accounts.map((account) => subscriptionOf(account, settings, refresh)));
    },
    async models(id, settings) {
      const accountId = accountOfSubscriptionKey(id);
      const account = (await options.accounts.list()).accounts.find((entry) => entry.id === accountId);
      return account == null ? undefined : (await rows(account, settings, false)).models;
    },
  };
}
