import { rm } from "node:fs/promises";
import { describeSubscriptionAuth } from "@vgent/providers";
import type { RemoteService } from "../remote/service.js";
import { GitHubAuthError } from "../remote/github.js";
import { probeClaudeLogin, type ClaudeLoginStatus } from "../subscriptions.js";
import type { ModelEntry } from "../models.js";
import { claudeAccountEnv, claudeHomeOf, logoutClaude, probeClaudeAccount, readClaudeUsageToken, startClaudeLogin } from "./claude.js";
import type { CliLogin } from "./cli-login.js";
import { codexHomeOf, codexTokens, logoutCodex, probeCodexAccount, startCodexLogin } from "./codex.js";
import { createCopilotAccess } from "./copilot.js";
import { createGitHubAccounts, type GitHubAccounts } from "./github.js";
import { createAccountRegistry, useEnabled, type AccountRecord, type AccountRegistry } from "./registry.js";
import { accountModelKey, accountSpec, DEFAULT_ACCOUNT, isAccountId, isDefaultAccount, kindOfAccount, newAccountId } from "./spec.js";
import { ACCOUNT_USES, type AccountId, type AccountKind, type AccountLoginAttempt, type AccountSnapshot, type AccountSummary, type AccountUsage, type AccountUse } from "./types.js";
import { accountJson, object, parseClaudeUsage, parseCodexUsage, parseCopilotUsage, unavailable } from "./usage.js";

const KIND_NAME: Record<AccountKind, string> = { codex: "Codex", claude: "Claude", github: "GitHub" };
/** The order accounts are listed in: the engines' own order, then GitHub. */
const KIND_ORDER: readonly AccountKind[] = ["codex", "claude", "github"];

export class AccountError extends Error {}

/**
 * Every account, one projection for every surface: the account page, the
 * sidebar's usage panel, quota, model lists, the engines. Each login's owner
 * stays authoritative — the vendor CLI for Claude and Codex, Vgent's keychain
 * item for GitHub — and nothing here copies a credential anywhere.
 */
export function createAccountService(options: {
  dataDir: string;
  registry?: AccountRegistry;
  github?: GitHubAccounts;
  remote?: RemoteService;
  probeClaude?: (env?: NodeJS.ProcessEnv) => Promise<ClaudeLoginStatus>;
  probeCodex?: typeof describeSubscriptionAuth;
  fetch?: typeof fetch;
  claudeToken?: (home: string | undefined) => Promise<string | undefined>;
  /** Test seams for the vendor CLIs. */
  cli?: {
    login?: (kind: "claude" | "codex", home: string | undefined, changed: () => void) => Promise<CliLogin>;
    logout?: (kind: "claude" | "codex", home: string | undefined) => Promise<void>;
  };
  changed?: () => void;
}) {
  const { dataDir } = options;
  const fetcher = options.fetch ?? fetch;
  const registry = options.registry ?? createAccountRegistry(dataDir);
  const github = options.github ?? createGitHubAccounts({ dataDir, registry });
  const probeClaude = options.probeClaude ?? probeClaudeLogin;
  const probeCodex = options.probeCodex ?? describeSubscriptionAuth;
  const claudeToken = options.claudeToken ?? readClaudeUsageToken;
  const login = options.cli?.login ?? ((kind, home, changed) => (kind === "claude" ? startClaudeLogin(home, changed) : startCodexLogin(home!, changed)));
  const logoutCli = options.cli?.logout ?? ((kind, home) => (kind === "claude" ? logoutClaude(home) : logoutCodex(home!)));

  const homeOf = (id: AccountId): string | undefined => (kindOfAccount(id) === "claude" ? claudeHomeOf(dataDir, id) : kindOfAccount(id) === "codex" ? codexHomeOf(dataDir, id) : undefined);

  const copilots = new Map<AccountId, ReturnType<typeof createCopilotAccess>>();
  const copilot = (id: AccountId) => {
    let access = copilots.get(id);
    if (access == null) { access = createCopilotAccess(() => github.access(id), fetcher); copilots.set(id, access); }
    return access;
  };

  let revision = 0;
  let cache: { at: number; data: AccountSnapshot; usageAt: number } | undefined;
  let pending: { usage: boolean; promise: Promise<AccountSnapshot> } | undefined;
  let identities: string | undefined;
  const invalidate = () => {
    revision++; cache = undefined; pending = undefined;
    for (const access of copilots.values()) access.invalidate();
    options.changed?.();
  };

  /** Every account as it stands, without quota. */
  async function enumerate(): Promise<Array<{ summary: AccountSummary; home: string | undefined }>> {
    const [records, remote] = await Promise.all([registry.list(), options.remote?.getState()]);
    const recordOf = (id: AccountId) => records.find((record) => record.id === id);
    const owned = (kind: AccountKind) => records.filter((record) => record.kind === kind && !isDefaultAccount(record.id)).map((record) => record.id);
    const uses = (id: AccountId, kind: AccountKind): AccountSummary["uses"] =>
      ACCOUNT_USES[kind]
        .filter((use) => use !== "remote" || options.remote != null)
        .map((use) => ({ id: use, enabled: use === "remote" ? remote?.accountId === id && remote.enabled : useEnabled(recordOf(id), use) }));
    const base = (id: AccountId, kind: AccountKind): AccountSummary => ({ id, kind, name: KIND_NAME[kind], ...(isDefaultAccount(id) && kind !== "github" ? { machine: true } : {}), uses: uses(id, kind) });

    const codex = await Promise.all([DEFAULT_ACCOUNT.codex, ...owned("codex")].map(async (id) => {
      const home = codexHomeOf(dataDir, id);
      const status = (await probeCodexAccount(home, probeCodex).catch(() => undefined))?.codex;
      // The machine's login is an account while it is signed in; one added here stays until it is removed.
      if (isDefaultAccount(id) && status?.available !== true) return undefined;
      return { home, summary: { ...base(id, "codex"), loggedIn: status?.available === true, ...(status?.email ? { email: status.email } : {}), ...(status?.plan ? { plan: status.plan } : {}) } };
    }));
    const claude = await Promise.all([DEFAULT_ACCOUNT.claude, ...owned("claude")].map(async (id) => {
      const home = claudeHomeOf(dataDir, id);
      const status = await probeClaudeAccount(home, probeClaude).catch(() => ({}) as ClaudeLoginStatus);
      if (isDefaultAccount(id) && status.loggedIn !== true) return undefined;
      const { orgId: _org, ...shown } = status;
      return { home, summary: { ...base(id, "claude"), ...shown } };
    }));
    const githubAccounts = await Promise.all(records.filter((record) => record.kind === "github").map(async (record) => {
      const who = await github.identity(record.id).catch(() => undefined);
      return { home: undefined, summary: { ...base(record.id, "github"), loggedIn: who != null, ...(who ? { username: who.username, avatarUrl: who.avatarUrl } : {}) } };
    }));
    const all = [...codex, ...claude, ...githubAccounts].filter((entry) => entry != null);
    return KIND_ORDER.flatMap((kind) => all.filter((entry) => entry.summary.kind === kind));
  }

  async function usage(account: AccountSummary, home: string | undefined): Promise<AccountUsage | undefined> {
    if (!account.loggedIn || account.method) return undefined;
    try {
      if (account.kind === "github") {
        const auth = await github.access(account.id);
        const raw = await accountJson("https://api.github.com/copilot_internal/user", { Authorization: `Bearer ${auth.accessToken}`, "User-Agent": "Vgent", Accept: "application/json" }, fetcher);
        if (github.revision(account.id) !== auth.revision) throw new Error("GitHub account changed");
        const plan = object(raw).copilot_plan; if (typeof plan === "string") account.plan = plan;
        return parseCopilotUsage(raw);
      }
      if (account.kind === "codex") {
        const tokens = codexTokens(home!);
        const auth = await tokens.getAccessToken();
        if (account.email && auth.email !== account.email) return { ...unavailable(undefined), message: "Codex 账号已变化，请刷新账号状态" };
        const raw = await accountJson("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${auth.accessToken}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}), "User-Agent": "codex-cli" }, fetcher);
        if ((await tokens.getAccessToken()).accountId !== auth.accountId) return { ...unavailable(undefined), message: "Codex 账号已变化，请刷新账号状态" };
        return parseCodexUsage(raw);
      }
      const token = await claudeToken(home);
      if (!token) return { ...unavailable(undefined), message: "Claude Code 登录可用于模型；未能读取同一登录的额度凭据" };
      const headers = { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" };
      // Do not merge a stale file/keychain belonging to a different CLI account.
      const profile = object(await accountJson("https://api.anthropic.com/api/oauth/profile", headers, fetcher));
      if (!account.email || object(profile.account).email !== account.email) return { ...unavailable(undefined), message: "额度凭据与 Claude Code 当前账号无法核对，请刷新登录状态" };
      return parseClaudeUsage(await accountJson("https://api.anthropic.com/api/oauth/usage", headers, fetcher));
    } catch (error) { return unavailable(error); }
  }

  async function list(input: { usage?: boolean; refresh?: boolean } = {}): Promise<AccountSnapshot> {
    const includeUsage = input.usage === true;
    if (!input.refresh && cache && Date.now() - (includeUsage ? cache.usageAt : cache.at) < 60_000) return cache.data;
    if (pending) {
      if (!includeUsage || pending.usage) return pending.promise;
      await pending.promise;
      return list(input);
    }
    const generation = revision;
    const promise = (async () => {
      const entries = await enumerate();
      const accounts = entries.map((entry) => entry.summary);
      const identity = JSON.stringify(accounts.map(({ usage: _usage, uses: _uses, ...who }) => who));
      if (generation !== revision) return list(input);
      if (identities != null && identities !== identity) { for (const access of copilots.values()) access.invalidate(); options.changed?.(); }
      const sameIdentity = identities === identity;
      identities = identity;
      // A cheap identity read must not evict the complete quota snapshot or
      // extend its freshness. Only retain usage when all identities still match.
      if (!includeUsage && sameIdentity && cache) for (const account of accounts) {
        const previous = cache.data.accounts.find((a) => a.id === account.id);
        if (previous?.usage) account.usage = previous.usage;
        if (!account.plan && previous?.plan) account.plan = previous.plan;
      }
      if (includeUsage) await Promise.all(entries.map(async ({ summary, home }) => { const u = await usage(summary, home); if (u) summary.usage = u; }));
      if (generation !== revision) return list(input);
      const data = { accounts, revision };
      cache = { at: Date.now(), data, usageAt: includeUsage ? Date.now() : sameIdentity ? cache?.usageAt ?? 0 : 0 };
      return data;
    })();
    pending = { usage: includeUsage, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
  }

  // --- signing in -------------------------------------------------------

  let attempt: AccountLoginAttempt & { cancel?: () => void; generation: number; cleanup?: () => Promise<void> } = { state: "idle", generation: 0 };
  const publicAttempt = (): AccountLoginAttempt => {
    const { cancel: _cancel, generation: _generation, cleanup: _cleanup, ...shown } = attempt;
    return shown;
  };

  /** Which account a new login of `kind` goes into: the machine's own slot while it is empty, else a new one. */
  const targetFor = async (kind: "claude" | "codex"): Promise<AccountId> => {
    if (kind === "claude") {
      const machine = await probeClaudeAccount(undefined, probeClaude).catch(() => ({}) as ClaudeLoginStatus);
      return machine.loggedIn === true ? newAccountId("claude") : DEFAULT_ACCOUNT.claude;
    }
    const machine = await probeCodexAccount(codexHomeOf(dataDir, DEFAULT_ACCOUNT.codex), probeCodex).catch(() => undefined);
    return machine?.codex.available === true ? newAccountId("codex") : DEFAULT_ACCOUNT.codex;
  };

  /** Who a Claude or Codex login is: two accounts with the same answer are the same login. */
  const whoIs = async (id: AccountId): Promise<string | undefined> => {
    const home = homeOf(id);
    if (kindOfAccount(id) === "claude") {
      const status = await probeClaudeAccount(home, probeClaude).catch(() => ({}) as ClaudeLoginStatus);
      return status.loggedIn === true ? `${status.email ?? ""}/${status.orgId ?? ""}` : undefined;
    }
    const status = (await probeCodexAccount(home!, probeCodex).catch(() => undefined))?.codex;
    return status?.available === true ? `${status.email ?? ""}/${status.accountId ?? ""}` : undefined;
  };

  const cliFailure = (kind: "claude" | "codex", error: unknown) =>
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? `找不到 ${kind === "claude" ? "Claude Code" : "Codex"} 命令行工具，请先安装后重试。`
      : "登录未完成或已超时，请重试。";
  const githubFailure = (error: unknown) => {
    if (error instanceof GitHubAuthError) {
      if (error.code === "invalid_client" || error.code === "device_flow_disabled") return "GitHub 登录配置不可用。请检查 GitHub 应用是否启用了设备登录。";
      if (error.code === "denied") return "GitHub 授权被拒绝，请重试。";
      if (error.code === "expired") return "验证码已过期，请重试。";
      if (["network_error", "rate_limited", "invalid_response", "request_failed"].includes(error.code)) return "暂时无法连接 GitHub，请检查网络后重试。";
    }
    return "GitHub 登录没有完成，请重试。";
  };

  async function startLogin(kind: AccountKind, relogin?: AccountId): Promise<AccountLoginAttempt> {
    if (attempt.state === "running") return publicAttempt();
    if (relogin != null && (!isAccountId(relogin) || kindOfAccount(relogin) !== kind)) throw new AccountError("没有这个账号");
    const generation = attempt.generation + 1;
    attempt = { kind, state: "running", generation };
    const current = () => attempt.generation === generation;
    const finish = (patch: Partial<AccountLoginAttempt>) => {
      if (!current()) return;
      attempt = { ...attempt, ...patch };
      delete attempt.cancel;
      delete attempt.cleanup;
      invalidate();
    };

    if (kind === "github") {
      const controller = new AbortController();
      attempt.cancel = () => controller.abort();
      try {
        const { authorization, done } = await github.beginLogin(controller.signal);
        if (!current()) { controller.abort(); return publicAttempt(); }
        attempt = { ...attempt, userCode: authorization.userCode, verificationUri: authorization.verificationUri };
        void done.then(
          async ({ id }) => {
            // The first GitHub account is what remote access runs as, unless it already runs as another.
            const remote = await options.remote?.getState();
            if (remote != null && remote.accountId == null) await options.remote?.selectAccount(id);
            finish({ state: "succeeded", accountId: id });
          },
          (error: unknown) => finish({ state: "failed", error: controller.signal.aborted ? "登录已取消。" : githubFailure(error) }),
        );
      } catch (error) {
        finish({ state: "failed", error: githubFailure(error) });
      }
      return publicAttempt();
    }

    const id = relogin ?? (await targetFor(kind));
    const home = homeOf(id);
    const fresh = relogin == null && !isDefaultAccount(id);
    // A new account's directory goes when its login does not happen.
    const cleanup = async () => { if (fresh && home != null) await rm(home, { recursive: true, force: true }); };
    attempt.cleanup = cleanup;
    let running: CliLogin | undefined;
    try {
      const cli = await login(kind, home, () => {
        const url = running?.url();
        if (current() && url != null) attempt = { ...attempt, url };
      });
      running = cli;
      if (!current()) { cli.cancel(); await cleanup(); return publicAttempt(); }
      // The link may have come before `running` was set.
      if (cli.url() != null) attempt = { ...attempt, url: cli.url()! };
      attempt.cancel = () => cli.cancel();
      void cli.done.then(async () => {
        if (!current()) return;
        const who = await whoIs(id);
        if (who == null) { await cleanup(); return finish({ state: "failed", error: "授权已结束，但没有确认到登录，请重试。" }); }
        if (fresh) {
          const others = (await registry.list()).filter((record) => record.kind === kind && record.id !== id).map((record) => record.id);
          const duplicate = await Promise.all([DEFAULT_ACCOUNT[kind], ...others].filter((other) => other !== id).map(whoIs)).then((all) => all.includes(who));
          if (duplicate) {
            await logoutCli(kind, home).catch(() => undefined);
            await cleanup();
            return finish({ state: "failed", error: "这个账号已经添加过了。" });
          }
          await registry.add({ id, kind });
        }
        finish({ state: "succeeded", accountId: id });
      }, async (error: unknown) => {
        if (!current()) return;
        await cleanup();
        finish({ state: "failed", error: cliFailure(kind, error) });
      });
    } catch (error) {
      await cleanup();
      finish({ state: "failed", error: cliFailure(kind, error) });
    }
    return publicAttempt();
  }

  // --- signing out ------------------------------------------------------

  async function logout(id: AccountId): Promise<void> {
    if (!isAccountId(id)) throw new AccountError("没有这个账号");
    const kind = kindOfAccount(id);
    invalidate();
    try {
      if (kind === "github") {
        await github.signOut(id);
        await registry.remove(id);
        await options.remote?.accountRemoved(id);
        copilots.delete(id);
        return;
      }
      const home = homeOf(id);
      const signOut = () => logoutCli(kind, home);
      try {
        if (kind === "codex") await codexTokens(home!).changeAccount(signOut);
        else await signOut();
      } catch (error) {
        // An account that is already signed out can still be removed; one that is not must not lose its directory.
        if ((await whoIs(id)) != null) throw error;
      }
      if (!isDefaultAccount(id) && home != null) await rm(home, { recursive: true, force: true });
      await registry.remove(id);
    } finally {
      invalidate();
    }
  }

  async function setUse(id: AccountId, use: AccountUse, enabled: boolean): Promise<void> {
    if (!isAccountId(id) || !ACCOUNT_USES[kindOfAccount(id)].includes(use)) throw new AccountError("这个账号没有这个用途");
    if (use === "remote") {
      const remote = options.remote;
      if (remote == null) throw new AccountError("远程访问暂不可用");
      if (enabled) {
        if ((await remote.getState()).accountId !== id) await remote.selectAccount(id);
        await remote.setEnabled(true);
      } else if ((await remote.getState()).accountId === id) {
        await remote.setEnabled(false);
      }
    } else {
      await registry.setUse(id, use, enabled);
    }
    invalidate();
  }

  // --- what the engines and model lists need ----------------------------

  /** The accounts of `kind` switched on for `use` and signed in, first account first. */
  async function usable(kind: AccountKind, use: AccountUse): Promise<AccountSummary[]> {
    return (await list()).accounts.filter((account) => account.kind === kind && account.loggedIn !== false && account.uses.some((entry) => entry.id === use && entry.enabled));
  }

  /** Copilot's models for every GitHub account switched on for it, each under its own account. */
  async function copilotModels(refresh = false): Promise<ModelEntry[]> {
    const accounts = await usable("github", "models");
    const lists = await Promise.all(accounts.map(async (account) => {
      const entries = await copilot(account.id).models(refresh).catch(() => [] as ModelEntry[]);
      return entries.map((entry) => {
        const model = entry.id.slice("github-copilot:".length);
        return {
          ...entry,
          id: accountSpec(account.id, entry.id),
          modelKey: accountModelKey(account.id, model),
          source: { ...entry.source!, account: account.id, name: account.username ? `GitHub Copilot · @${account.username}` : "GitHub Copilot" },
        };
      });
    }));
    return lists.flat();
  }

  return {
    list,
    invalidate,
    registry,
    github,
    usable,
    copilot,
    copilotModels,
    startLogin,
    loginStatus: publicAttempt,
    cancelLogin(): AccountLoginAttempt {
      // Only a login still under way is undone; a finished one keeps its account.
      const cleanup = attempt.state === "running" ? attempt.cleanup : undefined;
      if (attempt.state === "running") attempt.cancel?.();
      attempt = { state: "idle", generation: attempt.generation + 1 };
      void cleanup?.();
      return publicAttempt();
    },
    logout,
    setUse,
    /** The environment Claude Code runs under for this account. */
    claudeEnv: (id: AccountId) => claudeAccountEnv(dataDir, id),
    codexHome: (id: AccountId) => codexHomeOf(dataDir, id),
    recordOf: (id: AccountId): Promise<AccountRecord | undefined> => registry.get(id),
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
