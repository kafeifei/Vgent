import { describeSubscriptionAuth, getCodexTokenProvider } from "@vgent/providers";
import type { RemoteService } from "../remote/service.js";
import { probeClaudeLogin, type ClaudeLoginStatus } from "../subscriptions.js";
import { createCopilotAccess } from "./copilot.js";
import { accountJson, object, parseClaudeUsage, parseCodexUsage, parseCopilotUsage, readClaudeUsageToken, unavailable } from "./usage.js";
import type { AccountId, AccountSnapshot, AccountSummary, AccountUsage } from "./types.js";

/** One account projection for every surface; original credential owners remain authoritative. */
export function createAccountService(options: { remote?: RemoteService; probeClaude?: () => Promise<ClaudeLoginStatus>; probeCodex?: typeof describeSubscriptionAuth; fetch?: typeof fetch; claudeToken?: () => Promise<string | undefined>; changed?: () => void }) {
  const fetcher = options.fetch ?? fetch;
  const codex = getCodexTokenProvider();
  const githubAccess = async () => {
    if (!options.remote) throw new Error("GitHub unavailable");
    return options.remote.githubAccess();
  };
  const copilot = createCopilotAccess(githubAccess, fetcher);
  let revision = 0;
  let cache: { at: number; data: AccountSnapshot; usage: boolean } | undefined;
  let pending: { usage: boolean; promise: Promise<AccountSnapshot> } | undefined;
  let identities: string | undefined;
  const invalidate = () => { revision++; cache = undefined; pending = undefined; copilot.invalidate(); options.changed?.(); };
  async function usage(account: AccountSummary): Promise<AccountUsage | undefined> {
    if (!account.loggedIn || account.method) return undefined;
    try {
      if (account.id === "github") {
        const auth = await githubAccess();
        const raw = await accountJson("https://api.github.com/copilot_internal/user", { Authorization: `Bearer ${auth.accessToken}`, "User-Agent": "Vgent", Accept: "application/json" }, fetcher);
        if ((await githubAccess()).revision !== auth.revision) throw new Error("GitHub account changed");
        const plan = object(raw).copilot_plan; if (typeof plan === "string") account.plan = plan;
        return parseCopilotUsage(raw);
      }
      if (account.id === "codex") {
        const auth = await codex.getAccessToken();
        if (account.email && auth.email !== account.email) return { ...unavailable(undefined), message: "Codex 账号已变化，请刷新账号状态" };
        const raw = await accountJson("https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${auth.accessToken}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}), "User-Agent": "codex-cli" }, fetcher);
        if ((await codex.getAccessToken()).accountId !== auth.accountId) return { ...unavailable(undefined), message: "Codex 账号已变化，请刷新账号状态" };
        return parseCodexUsage(raw);
      }
      const token = await (options.claudeToken ?? readClaudeUsageToken)();
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
    if (!input.refresh && cache && (!includeUsage || cache.usage) && Date.now() - cache.at < 60_000) return cache.data;
    if (pending) {
      if (!includeUsage || pending.usage) return pending.promise;
      await pending.promise;
      return list(input);
    }
    const generation = revision;
    const promise = (async () => {
      const [remote, codexLogin, claude] = await Promise.all([
        options.remote?.getState(), (options.probeCodex ?? describeSubscriptionAuth)(), (options.probeClaude ?? probeClaudeLogin)().catch(() => ({} as ClaudeLoginStatus)),
      ]);
      const accounts: AccountSummary[] = [
        { id: "github", name: "GitHub", loggedIn: !!remote?.account, ...(remote?.account ? { username: remote.account.username, ...(remote.account.avatarUrl ? { avatarUrl: remote.account.avatarUrl } : {}) } : {}), engines: ["Vgent · Copilot"] },
        { id: "codex", name: "Codex", loggedIn: codexLogin.codex.available, ...(codexLogin.codex.email ? { email: codexLogin.codex.email } : {}), ...(codexLogin.codex.plan ? { plan: codexLogin.codex.plan } : {}), engines: ["Vgent", "Codex"] },
        { id: "claude", name: "Claude", ...claude, engines: ["Claude Code"] },
      ];
      const identity = JSON.stringify(accounts);
      if (generation !== revision) return list(input);
      if (identities != null && identities !== identity) { copilot.invalidate(); options.changed?.(); }
      identities = identity;
      if (includeUsage) await Promise.all(accounts.map(async a => { const u = await usage(a); if (u) a.usage = u; }));
      if (generation !== revision) return list(input);
      const data = { accounts, revision };
      cache = { at: Date.now(), data, usage: includeUsage };
      return data;
    })();
    pending = { usage: includeUsage, promise };
    try { return await promise; } finally { if (pending?.promise === promise) pending = undefined; }
  }
  return { list, invalidate, copilot, async change(id: AccountId, action: () => Promise<void>) {
    invalidate();
    try { if (id === "codex") await codex.changeAccount(action); else await action(); }
    finally { invalidate(); }
  } };
}
