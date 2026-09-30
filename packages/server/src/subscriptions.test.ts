import { describe, expect, it } from "vitest";
import type { ModelCatalog, ModelCatalogService, ModelEntry } from "./models.js";
import { DEFAULT_SETTINGS } from "./store/settings.js";
import { createSubscriptionService, markHidden, parseClaudeLoginStatus, withHiddenModels } from "./subscriptions.js";
import type { AccountSummary, AccountUse } from "./accounts/types.js";
import type { EngineId } from "./types.js";

const catalogOf = (lists: Record<EngineId, ModelEntry[]>, warning?: string): ModelCatalogService => ({
  list: async (engine): Promise<ModelCatalog> => ({
    engine,
    models: lists[engine],
    source: "test",
    fetchedAt: "2026-09-19T00:00:00.000Z",
    ...(warning != null && engine === "codex" ? { warning } : {}),
  }),
});

describe("parseClaudeLoginStatus", () => {
  it("reads who is signed in and on which plan", () => {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "dev@example.com", orgId: "org-1", subscriptionType: "max" });
    expect(parseClaudeLoginStatus(stdout)).toEqual({ loggedIn: true, email: "dev@example.com", plan: "max", orgId: "org-1" });
  });

  it("says so when the login is not the subscription", () => {
    expect(parseClaudeLoginStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" }))).toEqual({ loggedIn: true, method: "api_key" });
  });

  it("reports signed out, and nothing at all when there was no answer to read", () => {
    expect(parseClaudeLoginStatus(JSON.stringify({ loggedIn: false, authMethod: "none" }))).toEqual({ loggedIn: false });
    expect(parseClaudeLoginStatus("")).toEqual({});
    expect(parseClaudeLoginStatus("claude: command not found")).toEqual({});
  });
});

describe("withHiddenModels / markHidden", () => {
  it("switching off adds once, switching on removes, other agents are left alone", () => {
    const off = withHiddenModels({ codex: ["gpt-5.5"] }, "vgent", ["a", "b"], false);
    expect(off).toEqual({ codex: ["gpt-5.5"], vgent: ["a", "b"] });
    expect(withHiddenModels(off, "vgent", ["a"], false).vgent).toEqual(["a", "b"]);
    expect(withHiddenModels(off, "vgent", ["a"], true)).toEqual({ codex: ["gpt-5.5"], vgent: ["b"] });
  });

  it("marks an agent's own model, never a provider's with the same id", () => {
    const models: ModelEntry[] = [{ id: "sonnet", label: "sonnet" }, { id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet", provider: "网关" }];
    expect(markHidden(models, ["sonnet"])).toEqual([{ id: "sonnet", label: "sonnet", hidden: true }, { id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet", provider: "网关" }]);
    expect(markHidden(models, undefined)).toEqual(models);
  });
});

describe("createSubscriptionService", () => {
  const claude = (account: string, name: string) => ({ kind: "claude-subscription" as const, name, account });
  const codex = { kind: "codex-subscription" as const, name: "Codex · a@example.com", account: "codex" };
  const LISTS: Record<EngineId, ModelEntry[]> = {
    "claude-code": [
      { id: "sonnet", label: "sonnet", source: claude("claude", "Claude · a@example.com") },
      { id: "opus", label: "opus", source: claude("claude", "Claude · a@example.com") },
      { id: "@claude-0a1b2c3d:sonnet", label: "sonnet", source: claude("claude-0a1b2c3d", "Claude · b@example.com") },
    ],
    codex: [
      { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 272_000, source: codex },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", source: codex },
    ],
    vgent: [
      { id: "codex-subscription:gpt-5.5", label: "GPT-5.5", contextWindow: 272_000, source: codex },
      { id: "codex-subscription:gpt-5.5-mini", label: "GPT-5.5 mini", source: codex },
      // A gateway model: the in-house agent's own, but no account's.
      { id: "openai/gpt-5", label: "GPT-5", source: { kind: "gateway", name: "AI Gateway" } },
    ],
  };
  const uses = (...on: AccountUse[]) => (["models", "remote"] as const).map((id) => ({ id, enabled: on.includes(id) }));
  const ACCOUNTS: AccountSummary[] = [
    { id: "codex", kind: "codex", name: "Codex", loggedIn: true, email: "a@example.com", machine: true, uses: uses("models") },
    { id: "claude", kind: "claude", name: "Claude", loggedIn: true, email: "a@example.com", plan: "max", machine: true, uses: uses("models") },
    { id: "claude-0a1b2c3d", kind: "claude", name: "Claude", loggedIn: true, email: "b@example.com", uses: uses("models") },
    // Signed out, or on for nothing that brings models: not a subscription row.
    { id: "claude-11111111", kind: "claude", name: "Claude", loggedIn: false, uses: uses("models") },
    { id: "github", kind: "github", name: "GitHub", loggedIn: true, username: "octo", uses: uses("remote") },
  ];
  const service = (accounts = ACCOUNTS) =>
    createSubscriptionService({ modelCatalog: catalogOf(LISTS), accounts: { list: async () => ({ accounts, revision: 1 }), copilotModels: async () => [] } });

  it("gives every signed-in account that brings models a row of its own, named after who is signed in", async () => {
    const rows = await service().list(DEFAULT_SETTINGS);
    expect(rows.map((row) => [row.id, row.accountId, row.name, row.agents])).toEqual([
      ["codex-subscription", "codex", "Codex · a@example.com", ["vgent", "codex"]],
      ["claude-subscription", "claude", "Claude · a@example.com", ["claude-code"]],
      ["claude-subscription@claude-0a1b2c3d", "claude-0a1b2c3d", "Claude · b@example.com", ["claude-code"]],
    ]);
  });

  it("keeps each Claude account's models to itself", async () => {
    const rows = await service().list(DEFAULT_SETTINGS);
    expect(rows[1]?.models.map((model) => model.agents["claude-code"]?.spec)).toEqual(["sonnet", "opus"]);
    expect(rows[2]?.models).toEqual([{ id: "sonnet", label: "sonnet", agents: { "claude-code": { spec: "@claude-0a1b2c3d:sonnet", enabled: true } } }]);
  });

  it("gives one row per Codex model with both agents' ids for it, and leaves the gateway's models out", async () => {
    const [row] = await service().list({ ...DEFAULT_SETTINGS, hiddenModels: { vgent: ["codex-subscription:gpt-5.5-mini"] } });
    expect(row?.models).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 272_000, agents: { vgent: { spec: "codex-subscription:gpt-5.5", enabled: true }, codex: { spec: "gpt-5.5", enabled: true } } },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", agents: { vgent: { spec: "codex-subscription:gpt-5.5-mini", enabled: false }, codex: { spec: "gpt-5.5-mini", enabled: true } } },
    ]);
  });

  it("leaves out an account whose models are switched off", async () => {
    const accounts = ACCOUNTS.map((account) => (account.id === "codex" ? { ...account, uses: uses() } : account));
    expect((await service(accounts).list(DEFAULT_SETTINGS)).map((row) => row.accountId)).toEqual(["claude", "claude-0a1b2c3d"]);
  });

  it("answers one account's rows by its key, and nothing for one that is not there", async () => {
    expect((await service().models("claude-subscription@claude-0a1b2c3d", DEFAULT_SETTINGS))?.length).toBe(1);
    expect(await service().models("claude-subscription@claude-99999999", DEFAULT_SETTINGS)).toBeUndefined();
  });
});
