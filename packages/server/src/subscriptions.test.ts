import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog, ModelCatalogService, ModelEntry } from "./models.js";
import { DEFAULT_SETTINGS } from "./store/settings.js";
import { createSubscriptionService, markHidden, parseClaudeLoginStatus, withHiddenModels } from "./subscriptions.js";
import { createAccountService } from "./accounts/service.js";
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

const LISTS: Record<EngineId, ModelEntry[]> = {
  "claude-code": [
    { id: "sonnet", label: "sonnet" },
    { id: "opus", label: "opus" },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 272_000 },
    { id: "gpt-5.5-mini", label: "GPT-5.5 mini" },
  ],
  vgent: [
    { id: "codex-subscription:gpt-5.5", label: "GPT-5.5", contextWindow: 272_000 },
    { id: "codex-subscription:gpt-5.5-mini", label: "GPT-5.5 mini" },
    // A gateway model: the in-house agent's own, but no subscription's.
    { id: "openai/gpt-5", label: "GPT-5" },
  ],
};

describe("parseClaudeLoginStatus", () => {
  it("reads who is signed in and on which plan", () => {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "dev@example.com", orgId: "org-1", subscriptionType: "max" });
    expect(parseClaudeLoginStatus(stdout)).toEqual({ loggedIn: true, email: "dev@example.com", plan: "max" });
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
  const service = (probe: () => Promise<{ loggedIn?: boolean; email?: string; plan?: string }>, warning?: string) =>
    createSubscriptionService({ modelCatalog: catalogOf(LISTS, warning), accounts: createAccountService({ probeClaude: probe, probeCodex: async () => ({ codex: { available: false, source: null } }) }) });

  it("uses one identity read for both quota surfaces and model management", async () => {
    const probe = vi.fn(async () => ({ loggedIn: true, email: "same@example.com" }));
    const accounts = createAccountService({ probeClaude: probe, probeCodex: async () => ({ codex: { available: false, source: null } }) });
    const models = createSubscriptionService({ modelCatalog: catalogOf(LISTS), accounts });
    const [identity, listing] = await Promise.all([accounts.list(), models.list(DEFAULT_SETTINGS)]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(listing[0]?.email).toBe(identity.accounts.find(a => a.id === "claude")?.email);
    expect(listing.map(a => a.id)).toEqual(["claude-subscription", "codex-subscription", "github-copilot"]);
  });

  it("lists the Claude login for Claude Code alone, and says why", async () => {
    const [claude] = await service(async () => ({ loggedIn: true, email: "dev@example.com", plan: "max" })).list(DEFAULT_SETTINGS);
    expect(claude).toMatchObject({ id: "claude-subscription", loggedIn: true, email: "dev@example.com", plan: "max", agents: ["claude-code"], loginCommand: "claude auth login" });
    expect(claude?.note).toContain("Claude Code");
    expect(claude?.models).toEqual([
      { id: "sonnet", label: "sonnet", agents: { "claude-code": { spec: "sonnet", enabled: true } } },
      { id: "opus", label: "opus", agents: { "claude-code": { spec: "opus", enabled: true } } },
    ]);
  });

  it("gives one row per Codex model with both agents' ids for it, and leaves the gateway's models out", async () => {
    const [, codex] = await service(async () => ({}), "Codex 未登录").list({ ...DEFAULT_SETTINGS, hiddenModels: { vgent: ["codex-subscription:gpt-5.5-mini"] } });
    expect(codex).toMatchObject({ id: "codex-subscription", loggedIn: false, agents: ["vgent", "codex"], loginCommand: "codex login", warning: "Codex 未登录" });
    expect(codex?.models).toEqual([
      { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 272_000, agents: { vgent: { spec: "codex-subscription:gpt-5.5", enabled: true }, codex: { spec: "gpt-5.5", enabled: true } } },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", agents: { vgent: { spec: "codex-subscription:gpt-5.5-mini", enabled: false }, codex: { spec: "gpt-5.5-mini", enabled: true } } },
    ]);
  });

  it("leaves the login state out when nobody can say, and survives a probe that throws", async () => {
    const [unknown] = await service(async () => ({})).list(DEFAULT_SETTINGS);
    expect(unknown && "loggedIn" in unknown).toBe(false);
    const [failed] = await service(async () => {
      throw new Error("spawn EACCES");
    }).list(DEFAULT_SETTINGS);
    expect(failed && "loggedIn" in failed).toBe(false);
  });
});
