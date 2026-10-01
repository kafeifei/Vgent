import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubscriptionAuthStatus } from "@vgent/providers";
import type { ClaudeLoginStatus } from "../subscriptions.js";
import { createGitHubAccounts } from "./github.js";
import { createAccountRegistry, type AccountRegistry } from "./registry.js";
import { createAccountService } from "./service.js";
import { createCopilotAccess } from "./copilot.js";
import { parseClaudeUsage, parseCodexUsage, parseCopilotUsage } from "./usage.js";
import { USAGE_FALLBACK_INTERVAL } from "./usage-cache.js";

const signedOutCodex = async () => ({ codex: { available: false, source: null } });
function remoteFixture() {
  let loggedIn = true, revision = 0;
  return {
    getState: async () => ({ account: loggedIn ? { username: "example", name: "Example" } : null }),
    githubAccess: async () => { if (!loggedIn) throw new Error("signed out"); return { accessToken: "one-github-login", accountId: "123", revision }; },
    logout: async () => { loggedIn = false; revision++; },
  };
}

describe("quota adapters", () => {
  it("keeps missing data unknown, preserves real zeros and never invents reset dates", () => {
    expect(parseCodexUsage({}).status).toBe("unavailable");
    const codex = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 2000000000 } } });
    expect(codex.windows[0]).toMatchObject({ usedPercent: 0, label: "5 小时", resetsAt: new Date(2000000000000).toISOString() });
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 31, resets_at: null } }).windows).toEqual([{ id: "seven_day", label: "每周", usedPercent: 31 }]);
    expect(parseCopilotUsage({ quota_snapshots: { chat: { unlimited: true } } }).windows).toEqual([{ id: "chat", label: "聊天", unlimited: true }]);
  });
  it("maps model-specific windows, extra spending and AI credits without double counting", () => {
    const claude = parseClaudeUsage({ seven_day_opus: { utilization: 65 }, extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000, utilization: 25 } });
    expect(claude.windows[1]).toMatchObject({ used: 2.5, limit: 10, unit: "USD" });
    const copilot = parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: 72, credits_used: 40 }, chat: { unlimited: true, credits_used: 40 } } });
    expect(copilot.windows[0]?.usedPercent).toBe(28);
    expect(copilot.windows.filter(w => w.id === "ai-credits")).toHaveLength(1);
  });
});

/** A fake keychain and GitHub, behind the real GitHub account store. */
function githubFixture(registry: AccountRegistry, users: Array<{ id: number; username: string }> = [{ id: 7, username: "octo" }]) {
  const items = new Map<string, string>();
  let next = 0;
  const command = vi.fn(async (args: string[], input?: string) => {
    if (input != null) {
      const [, , , account, , , , value] = input.trim().split(" ");
      items.set(account!, value!);
      return "";
    }
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "delete-generic-password") { items.delete(account); return ""; }
    const value = items.get(account);
    if (value == null) throw Object.assign(new Error("not found"), { code: 44 });
    return value;
  });
  const client = {
    beginGitHubLogin: async () => ({ deviceCode: "device", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 60_000, interval: 1 }),
    waitGitHubLogin: async () => ({ accessToken: `token-${next++}` }),
    getGitHubAccount: async (token: string) => {
      const index = Number(token.slice("token-".length));
      const user = users[Math.min(index, users.length - 1)]!;
      return { ...user, name: user.username };
    },
    refreshGitHubCredential: async () => ({ accessToken: "refreshed" }),
    exchangeGitHubCode: async () => ({ status: "pending" as const }),
  };
  const github = createGitHubAccounts({ dataDir: "/isolated/vgent", registry, command, client, platform: "darwin" });
  return { github, items, command };
}

const probeByDir = (who: Record<string, ClaudeLoginStatus>) => async (env?: NodeJS.ProcessEnv): Promise<ClaudeLoginStatus> => who[env?.CLAUDE_CONFIG_DIR ?? "machine"] ?? { loggedIn: false };

async function serviceFixture(options: { claude?: Record<string, ClaudeLoginStatus>; users?: Array<{ id: number; username: string }>; fetch?: typeof fetch } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "vgent-accounts-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const registry = createAccountRegistry(dataDir);
  const { github, items } = githubFixture(registry, options.users);
  const claude = { ...(options.claude ?? {}) };
  const codex: Record<string, SubscriptionAuthStatus> = {};
  const logouts: Array<string | undefined> = [];
  const logins: Array<{ home: string | undefined; finish: () => void; fail: () => void }> = [];
  const service = createAccountService({
    dataDir, registry, github,
    probeClaude: probeByDir(claude),
    probeCodex: async ({ env } = {}) => ({ codex: codex[env?.CODEX_HOME ?? ""] ?? { available: false, source: null } }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    cli: {
      login: async (_kind, home) => {
        let finish!: () => void, fail!: () => void;
        const done = new Promise<void>((resolve, reject) => { finish = resolve; fail = () => reject(new Error("exit 1")); });
        done.catch(() => {});
        logins.push({ home, finish, fail });
        return { url: () => "https://claude.ai/oauth/authorize?x=1", done, cancel: () => fail() };
      },
      logout: async (kind, home) => {
        logouts.push(home);
        if (kind === "claude") delete claude[home ?? "machine"];
        else delete codex[home!];
      },
    },
  });
  return { dataDir, registry, service, claude, codex, logins, logouts, items };
}

async function cliAccountFixture(kind: "claude" | "codex") {
  const fixture = await serviceFixture();
  const homeOf = (id: string) => kind === "codex" ? fixture.service.codexHome(id) : id === "claude" ? undefined : join(fixture.dataDir, "accounts", id);
  const signIn = (id: string, email = "a@example.com", group = "o1") => {
    const home = homeOf(id);
    if (kind === "claude") fixture.claude[home ?? "machine"] = { loggedIn: true, email, orgId: group };
    else fixture.codex[home!] = { available: true, source: null, email, accountId: group };
  };
  return { ...fixture, homeOf, signIn };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe("account service", () => {
  it("uses passive data on identity reads and forced refreshes without upstream requests; old reporters expire on account changes", async () => {
    const fetcher = vi.fn(async () => Response.json({ quota_snapshots: { chat: { unlimited: true } } })) as unknown as typeof fetch;
    const { service, registry, items } = await serviceFixture({ fetch: fetcher });
    await registry.add({ id: "github", kind: "github" });
    items.set("github", Buffer.from(JSON.stringify({ accessToken: "token-0" })).toString("base64"));
    const report = await service.bindUsage("github");
    await report(parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: 70 } } }));
    expect((await service.list()).accounts[0]?.usage?.windows[0]?.usedPercent).toBe(30);
    await service.list({ usage: true, refresh: true });
    await service.list({ usage: true, refresh: true });
    expect(fetcher).not.toHaveBeenCalled();
    service.invalidate();
    await report(parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: 5 } } }));
    expect((await service.list()).accounts[0]?.usage?.windows[0]?.usedPercent).toBe(30);
  });

  it("lists the machine's login and every added account, and projects no secrets", async () => {
    const { registry, dataDir } = await serviceFixture();
    const home = join(dataDir, "accounts", "claude-0a1b2c3d");
    await registry.add({ id: "claude-0a1b2c3d", kind: "claude" });
    const probe = probeByDir({ machine: { loggedIn: true, email: "a@example.com", orgId: "o1" }, [home]: { loggedIn: true, email: "b@example.com", orgId: "o2" } });
    const listed = createAccountService({ dataDir, registry, probeClaude: probe, probeCodex: signedOutCodex });
    const snapshot = await listed.list();
    expect(snapshot.accounts.map((a) => [a.id, a.kind, a.email, a.machine ?? false])).toEqual([
      ["claude", "claude", "a@example.com", true],
      ["claude-0a1b2c3d", "claude", "b@example.com", false],
    ]);
    expect(snapshot.accounts[0]?.uses).toEqual([{ id: "models", enabled: true }]);
    expect(JSON.stringify(snapshot)).not.toContain("orgId");
  });

  it("signs a second Claude account in to a directory of its own, and keeps it", async () => {
    const { service, claude, logins, registry, dataDir } = await serviceFixture({ claude: { machine: { loggedIn: true, email: "a@example.com", orgId: "o1" } } });
    const started = await service.startLogin("claude");
    expect(started).toMatchObject({ kind: "claude", state: "running", url: "https://claude.ai/oauth/authorize?x=1" });
    const home = logins[0]!.home!;
    expect(home.startsWith(join(dataDir, "accounts", "claude-"))).toBe(true);
    claude[home] = { loggedIn: true, email: "b@example.com", orgId: "o2" };
    logins[0]!.finish();
    await vi.waitFor(() => expect(service.loginStatus().state).toBe("succeeded"));
    const id = service.loginStatus().accountId!;
    expect(id).toMatch(/^claude-[0-9a-f]{8}$/);
    expect((await registry.list()).map((record) => record.id)).toEqual([id]);
    expect((await service.list({ refresh: true })).accounts.map((a) => a.email)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("undoes a second login as someone already here", async () => {
    const { service, claude, logins, logouts, registry } = await serviceFixture({ claude: { machine: { loggedIn: true, email: "a@example.com", orgId: "o1" } } });
    await service.startLogin("claude");
    const home = logins[0]!.home!;
    claude[home] = { loggedIn: true, email: "a@example.com", orgId: "o1" };
    logins[0]!.finish();
    await vi.waitFor(() => expect(service.loginStatus().state).toBe("failed"));
    expect(service.loginStatus().error).toContain("已经添加过了");
    expect(logouts).toEqual([home]);
    expect(await registry.list()).toEqual([]);
    await expect(access(home)).rejects.toThrow();
  });

  describe.each(["claude", "codex"] as const)("%s login recovery", (kind) => {
    it.each([false, true])("rejects a duplicate when an empty machine slot is signed in (re-login: %s)", async relogin => {
      const { service, registry, signIn, logins, logouts, homeOf } = await cliAccountFixture(kind);
      const existing = `${kind}-0a1b2c3d`;
      await registry.add({ id: existing, kind });
      signIn(existing);
      await service.startLogin(kind, relogin ? kind : undefined);
      expect(logins[0]?.home).toBe(homeOf(kind));
      signIn(kind);
      logins[0]!.finish();
      await vi.waitFor(() => expect(service.loginStatus().state).toBe("failed"));
      expect(service.loginStatus().error).toContain("已经添加过了");
      expect(logouts).toEqual([homeOf(kind)]);
      expect((await service.list({ refresh: true })).accounts.map(a => a.id)).toEqual([existing]);
    });

    it("rejects a re-login into another account's identity and keeps the account's switches", async () => {
      const { service, registry, signIn, logins, logouts, homeOf } = await cliAccountFixture(kind);
      const target = `${kind}-0a1b2c3d`;
      signIn(kind);
      await registry.add({ id: target, kind, uses: { models: false } });
      signIn(target, "b@example.com", "o2");
      await service.startLogin(kind, target);
      signIn(target);
      logins[0]!.finish();
      await vi.waitFor(() => expect(service.loginStatus().state).toBe("failed"));
      expect(service.loginStatus().error).toContain("已经添加过了");
      expect(logouts).toEqual([homeOf(target)]);
      expect(await registry.get(target)).toMatchObject({ uses: { models: false } });
      const accounts = (await service.list({ refresh: true })).accounts;
      expect(accounts.find(a => a.id === kind)?.loggedIn).toBe(true);
      expect(accounts.find(a => a.id === target)?.loggedIn).toBe(false);
    });

    it("renews the original slot without duplicating it or confusing another workspace on the same email", async () => {
      const { service, registry, signIn, logins, logouts, homeOf } = await cliAccountFixture(kind);
      const target = `${kind}-0a1b2c3d`;
      signIn(kind);
      await registry.add({ id: target, kind, uses: { models: false } });
      signIn(target, "a@example.com", "o2");
      await service.startLogin(kind, target);
      expect(logins[0]?.home).toBe(homeOf(target));
      logins[0]!.finish();
      await vi.waitFor(() => expect(service.loginStatus()).toMatchObject({ state: "succeeded", accountId: target }));
      expect(logouts).toEqual([]);
      expect(await registry.list()).toEqual([expect.objectContaining({ id: target, uses: { models: false } })]);
      expect((await service.list({ refresh: true })).accounts.map(a => a.id)).toEqual([kind, target]);
    });

    it("restores a missing account at the id pinned by the task, and cleans up an unsuccessful recovery", async () => {
      const { service, registry, signIn, logins, homeOf } = await cliAccountFixture(kind);
      const target = `${kind}-0a1b2c3d`;
      signIn(kind);
      await mkdir(homeOf(target)!, { recursive: true });
      await service.startLogin(kind, target);
      logins[0]!.fail();
      await vi.waitFor(() => expect(service.loginStatus().state).toBe("failed"));
      await expect(access(homeOf(target)!)).rejects.toThrow();
      expect(await registry.list()).toEqual([]);
      await service.startLogin(kind, target);
      signIn(target, "b@example.com", "o2");
      logins[1]!.finish();
      await vi.waitFor(() => expect(service.loginStatus()).toMatchObject({ state: "succeeded", accountId: target }));
      expect((await registry.list()).map(a => a.id)).toEqual([target]);
      expect((await service.list({ refresh: true })).accounts.map(a => a.id)).toEqual([kind, target]);
    });
  });

  it("signs in to the machine's own login while it is free, and cancels cleanly", async () => {
    const { service, logins } = await serviceFixture();
    await service.startLogin("claude");
    expect(logins[0]?.home).toBeUndefined();
    expect(service.cancelLogin()).toEqual({ state: "idle" });
  });

  it("switches a use off for one account only, and signs an added account out with its directory", async () => {
    const { service, registry, dataDir, logouts } = await serviceFixture();
    const home = join(dataDir, "accounts", "claude-0a1b2c3d");
    await mkdir(home, { recursive: true });
    await registry.add({ id: "claude-0a1b2c3d", kind: "claude" });
    await service.setUse("claude-0a1b2c3d", "models", false);
    expect((await registry.get("claude-0a1b2c3d"))?.uses).toEqual({ models: false });
    await expect(service.setUse("claude", "remote", true)).rejects.toThrow("没有这个用途");
    await service.logout("claude-0a1b2c3d");
    expect(logouts).toEqual([home]);
    expect(await registry.list()).toEqual([]);
    await expect(access(home)).rejects.toThrow();
  });

  it("keeps each GitHub account apart, renews a login for the same user, and forgets one on sign-out", async () => {
    const { service, registry, items } = await serviceFixture({ users: [{ id: 7, username: "octo" }, { id: 8, username: "cat" }, { id: 7, username: "octo" }] });
    const signIn = async () => {
      const started = await service.startLogin("github");
      expect(started).toMatchObject({ state: "running", userCode: "ABCD-EFGH" });
      await vi.waitFor(() => expect(service.loginStatus().state).toBe("succeeded"));
      return service.loginStatus().accountId!;
    };
    expect(await signIn()).toBe("github");
    const second = await signIn();
    expect(second).toMatch(/^github-[0-9a-f]{8}$/);
    expect(await signIn()).toBe("github");
    expect((await registry.list()).map((record) => record.id)).toEqual(["github", second]);
    expect([...items.keys()].sort()).toEqual(["github", second].sort());
    expect(JSON.stringify(await service.list({ refresh: true }))).not.toContain("token-");
    await service.logout("github");
    expect([...items.keys()]).toEqual([second]);
    expect((await service.list({ refresh: true })).accounts.map((a) => a.username)).toEqual(["cat"]);
  });

  it("drops the per-engine switches an earlier build kept, and keeps a switched-off account off", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vgent-accounts-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    await writeFile(join(dataDir, "accounts.json"), JSON.stringify({ version: 1, accounts: [
      { id: "codex-0a1b2c3d", kind: "codex", uses: { vgent: false }, addedAt: "2026-09-29T00:00:00.000Z" },
      { id: "claude-0a1b2c3d", kind: "claude", uses: { models: false, "claude-code": false }, addedAt: "2026-09-29T00:00:00.000Z" },
    ] }));
    const registry = createAccountRegistry(dataDir);
    expect((await registry.get("codex-0a1b2c3d"))?.uses).toBeUndefined();
    expect((await registry.get("claude-0a1b2c3d"))?.uses).toEqual({ models: false });
  });

  it("does not read subscription credentials for a Claude API-key login", async () => {
    const token = vi.fn();
    const dataDir = await mkdtemp(join(tmpdir(), "vgent-accounts-"));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const service = createAccountService({ dataDir, probeClaude: async () => ({ loggedIn: true, method: "api_key" }), probeCodex: signedOutCodex, claudeToken: token });
    const result = await service.list({ usage: true });
    expect(result.accounts[0]?.method).toBe("api_key"); expect(token).not.toHaveBeenCalled();
  });

  it("identity-only reads retain quotas without postponing their next refresh", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fetcher = vi.fn(async () => Response.json({ copilot_plan: "individual", quota_snapshots: { chat: { unlimited: true } } })) as unknown as typeof fetch;
      const { service, registry, items } = await serviceFixture({ fetch: fetcher });
      await registry.add({ id: "github", kind: "github" });
      items.set("github", Buffer.from(JSON.stringify({ accessToken: "token-0" })).toString("base64"));
      const full = await service.list({ usage: true });
      now += 61_000;
      const identity = await service.list();
      expect(identity.accounts[0]?.usage).toEqual(full.accounts[0]?.usage);
      expect(identity.accounts[0]?.plan).toBe("individual");
      await service.list({ usage: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += USAGE_FALLBACK_INTERVAL;
      await service.list({ usage: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
});

describe("GitHub credentials", () => {
  it("sends the credential over stdin, never argv, and reads back what was saved", async () => {
    const registry = createAccountRegistry(await mkdtemp(join(tmpdir(), "vgent-accounts-")));
    const { github, command } = githubFixture(registry);
    const { done } = await github.beginLogin(new AbortController().signal);
    await done;
    const write = command.mock.calls.find(([args]) => args[0] === "-i");
    expect(write?.[1]).toContain("add-generic-password -U -a github");
    expect(JSON.stringify(command.mock.calls.map(([args]) => args))).not.toContain(Buffer.from(JSON.stringify({ accessToken: "token-0" })).toString("base64"));
    expect(await github.token("github")).toBe("token-0");
  });

  it("each data directory uses its own keychain item", async () => {
    const names: string[] = [];
    for (const dataDir of ["/isolated/vgent-a", "/isolated/vgent-b"]) {
      const github = createGitHubAccounts({ dataDir, registry: createAccountRegistry(await mkdtemp(join(tmpdir(), "vgent-accounts-"))), platform: "darwin", command: async (args) => {
        names.push(args[args.indexOf("-s") + 1]!);
        throw Object.assign(new Error("not found"), { code: 44 });
      } });
      await expect(github.token("github")).rejects.toThrow("not signed in");
    }
    expect(names.every((name) => name.startsWith("dev.vgent.remote."))).toBe(true);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe("Copilot model access", () => {
  it("derives model access from the same GitHub login and rejects calls after logout", async () => {
    const remote = remoteFixture(), sent: { url: string; authorization: string | null }[] = [];
    const access = createCopilotAccess(remote.githubAccess, async (input, init) => {
      const url = String(input), authorization = new Headers(init?.headers).get("Authorization");
      sent.push({ url, authorization });
      if (url.endsWith("/token")) return Response.json({ token: "derived", expires_at: Date.now() / 1000 + 600 });
      if (url.endsWith("/models")) return Response.json({ data: [
        { id: "usable", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/chat/completions"] },
        { id: "responses-only", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/responses"] },
      ] });
      return Response.json({ id: "fixture", created: 1, model: "usable", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    const models = await access.models();
    expect(models.map(m => m.id)).toEqual(["github-copilot:usable", "github-copilot:responses-only"]);
    const { generateText } = await import("ai");
    const result = await generateText({ model: await access.model("usable"), prompt: "test", maxRetries: 0 });
    expect(result.text).toBe("ok");
    expect(sent[0]?.authorization).toBe("Bearer one-github-login");
    expect(sent.at(-1)?.authorization).toBe("Bearer derived");
    expect(sent.at(-1)?.url).toBe("https://api.githubcopilot.com/chat/completions");
    await remote.logout();
    await expect(access.available()).rejects.toThrow("signed out");
  });
});

it("executes Responses-only Copilot models, including a tool continuation, using the same login", async () => {
  const bodies: Record<string, unknown>[] = [], initiators: (string | null)[] = [];
  const access = createCopilotAccess(remoteFixture().githubAccess, async (input, init) => {
    const url = String(input);
    if (url.endsWith("/token")) return Response.json({ token: "derived", expires_at: Date.now() / 1000 + 600 });
    if (url.endsWith("/models")) return Response.json({ data: [
      { id: "responses-only", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/responses"] },
      { id: "disabled", capabilities: { type: "chat", supports: { tool_calls: true } }, policy: { state: "disabled" }, supported_endpoints: ["/responses"] },
    ] });
    expect(url).toBe("https://api.githubcopilot.com/responses");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer derived");
    bodies.push(JSON.parse(String(init?.body)));
    initiators.push(new Headers(init?.headers).get("X-Initiator"));
    const output = bodies.length === 1
      ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}", status: "completed" }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }];
    return Response.json({ id: `resp_${bodies.length}`, created_at: 1, model: "responses-only", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  const { generateText, tool, jsonSchema, stepCountIs } = await import("ai");
  const result = await generateText({ model: await access.model("responses-only"), prompt: "read it", maxRetries: 0,
    tools: { read: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => "file contents" }) }, stopWhen: stepCountIs(2) });
  expect(result.text).toBe("ok");
  expect(bodies.map(b => b.store)).toEqual([false, false]);
  expect(initiators).toEqual(["user", "agent"]);
  expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "file contents" }));
  await expect(access.model("disabled")).rejects.toThrow("unavailable");
});
