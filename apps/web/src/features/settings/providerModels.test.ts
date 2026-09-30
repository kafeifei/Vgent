import { describe, expect, it } from "vitest";
import type { CatalogProviderSummary, RedactedProviderConfig, SubscriptionAccount } from "@/lib/types";
import {
  EMPTY_CUSTOM_FORM,
  agentsOf,
  connectInput,
  connectableCatalog,
  customInput,
  describeSubscription,
  filterCatalog,
  filterModels,
  formatContext,
  isEnabled,
  modelRows,
  orderAdded,
  summarizeEnabled,
  summarizeSubscription,
  withModels,
  withShownOrder,
  withSubscriptionSwitch, withAgentChoices } from "./providerModels";

const deepseek: CatalogProviderSummary = {
  id: "deepseek",
  name: "DeepSeek",
  npm: "@ai-sdk/openai-compatible",
  modelCount: 4,
  agents: {
    vgent: { protocol: "openai-compatible", baseURL: "https://api.deepseek.com" },
    "claude-code": { protocol: "anthropic", baseURL: "https://api.deepseek.com/anthropic" },
  },
};

const azure: CatalogProviderSummary = { id: "azure", name: "Azure", npm: "@ai-sdk/azure", modelCount: 9, agents: { vgent: { protocol: "azure" } }, baseURLHint: "https://<资源名>.openai.azure.com/openai" };
const ollama: CatalogProviderSummary = { id: "ollama", name: "Ollama", npm: "@ai-sdk/openai-compatible", modelCount: 0, keyless: true, agents: { vgent: { protocol: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1" } } };

const usable = ["vgent", "claude-code"] as const;

describe("connectInput", () => {
  it("connects every agent the catalog has an address for, with no model ticked yet", () => {
    expect(connectInput(deepseek, usable, { apiKey: " sk-1 ", baseURL: "" })).toEqual({
      input: {
        name: "DeepSeek",
        presetId: "deepseek",
        apiKey: "sk-1",
        agents: {
          vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [] },
          "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic", models: [] },
        },
      },
    });
  });

  it("leaves out an agent that cannot take a provider", () => {
    const result = connectInput(deepseek, ["vgent"], { apiKey: "k", baseURL: "" });
    expect("input" in result && Object.keys(result.input.agents)).toEqual(["vgent"]);
  });

  it("asks for the key, except from a server that has none", () => {
    expect(connectInput(deepseek, usable, { apiKey: "  ", baseURL: "" })).toEqual({ error: "填上 API key" });
    const local = connectInput(ollama, usable, { apiKey: "", baseURL: "" });
    expect("input" in local && "apiKey" in local.input).toBe(false);
  });

  it("asks for the address only when the catalog has none, and checks it", () => {
    expect(connectInput(azure, usable, { apiKey: "k", baseURL: "" })).toEqual({ error: "填上接入地址" });
    expect(connectInput(azure, usable, { apiKey: "k", baseURL: "my-resource.openai.azure.com" })).toMatchObject({ error: expect.stringContaining("URL") });
    const ok = connectInput(azure, usable, { apiKey: "k", baseURL: "https://my-resource.openai.azure.com/openai/" });
    expect("input" in ok && ok.input.agents.vgent?.baseURL).toBe("https://my-resource.openai.azure.com/openai");
  });
});

describe("customInput", () => {
  it("gives Claude Code the same address when the protocol is already Anthropic, and only an explicit one otherwise", () => {
    const anthropic = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", protocol: "anthropic", baseURL: "https://gw.test/anthropic" }, usable);
    expect("input" in anthropic && anthropic.input.agents).toEqual({
      vgent: { baseURL: "https://gw.test/anthropic", protocol: "anthropic", models: [] },
      "claude-code": { baseURL: "https://gw.test/anthropic", protocol: "anthropic", models: [] },
    });

    const openai = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", baseURL: "https://gw.test/v1" }, usable);
    expect("input" in openai && Object.keys(openai.input.agents)).toEqual(["vgent"]);

    const both = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", baseURL: "https://gw.test/v1", claudeBaseURL: "https://gw.test" }, usable);
    expect("input" in both && both.input.agents["claude-code"]).toEqual({ baseURL: "https://gw.test", protocol: "anthropic", models: [] });
  });

  it("adds Codex at the same address only when the user says the service speaks Responses", () => {
    const all = ["vgent", "claude-code", "codex"] as const;
    const off = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", baseURL: "https://gw.test/v1" }, all);
    expect("input" in off && Object.keys(off.input.agents)).toEqual(["vgent"]);
    const on = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", baseURL: "https://gw.test/v1/", codexResponses: true }, all);
    expect("input" in on && on.input.agents.codex).toEqual({ baseURL: "https://gw.test/v1", protocol: "openai", models: [] });
    // An Anthropic-only service has no Responses endpoint to offer, whatever the switch says.
    const anthropic = customInput({ ...EMPTY_CUSTOM_FORM, name: "网关", protocol: "anthropic", baseURL: "https://gw.test/anthropic", codexResponses: true }, all);
    expect("input" in anthropic && anthropic.input.agents.codex).toBeUndefined();
  });

  it("says what is missing", () => {
    expect(customInput(EMPTY_CUSTOM_FORM, usable)).toEqual({ error: "给提供商起个名字" });
    expect(customInput({ ...EMPTY_CUSTOM_FORM, name: "x" }, usable)).toEqual({ error: "填上接入地址" });
  });
});

const connected: RedactedProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  presetId: "deepseek",
  hasKey: true,
  agents: {
    vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "v4-pro", label: "V4 Pro" }] },
    "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic", models: [] },
  },
};

describe("the model table", () => {
  it("lists what is on first, then the live listing, then the catalog — one row per id, keeping what any source knows", () => {
    const rows = modelRows(connected, { models: [{ id: "v4-flash", label: "V4 Flash", contextWindow: 128000 }, { id: "v4-pro", contextWindow: 64000 }] }, [{ id: "v5-preview" }, { id: "v4-flash" }]);
    expect(rows).toEqual([{ id: "v4-pro", label: "V4 Pro", contextWindow: 64000 }, { id: "v5-preview" }, { id: "v4-flash", label: "V4 Flash", contextWindow: 128000 }]);
  });

  it("turns a model on for one agent without touching the other, and never sends the key", () => {
    const input = withModels(connected, "claude-code", [{ id: "v4-pro", label: "V4 Pro" }], true);
    expect(input.agents["claude-code"]?.models).toEqual([{ id: "v4-pro", label: "V4 Pro" }]);
    expect(input.agents.vgent?.models).toEqual([{ id: "v4-pro", label: "V4 Pro" }]);
    expect(input).toMatchObject({ name: "DeepSeek", presetId: "deepseek" });
    expect("apiKey" in input).toBe(false);
  });

  it("turning on twice adds once; turning off removes; a whole column goes at once", () => {
    const twice = withModels(connected, "vgent", [{ id: "v4-pro" }, { id: "v4-flash" }], true);
    expect(twice.agents.vgent?.models.map((model) => model.id)).toEqual(["v4-pro", "v4-flash"]);
    const off = withModels({ ...connected, agents: twice.agents }, "vgent", [{ id: "v4-pro" }, { id: "v4-flash" }], false);
    expect(off.agents.vgent?.models).toEqual([]);
  });

  it("selects and clears search matches without changing other models or engines", () => {
    const models = [{ id: "v4-pro" }, { id: "v4-flash" }, { id: "v5-preview" }];
    const matching = filterModels(models, "v4");
    const initial = withModels(connected, "vgent", [{ id: "v5-preview" }], true);
    const on = withModels({ ...connected, agents: initial.agents }, "vgent", matching, true);
    expect(on.agents.vgent?.models.map(model => model.id)).toEqual(["v4-pro", "v5-preview", "v4-flash"]);
    const off = withModels({ ...connected, agents: on.agents }, "vgent", matching, false);
    expect(off.agents.vgent?.models).toEqual([{ id: "v5-preview" }]);
    expect(off.agents["claude-code"]).toEqual(connected.agents["claude-code"]);
  });

  it("force-enables an unconfigured agent by reusing an existing endpoint", () => {
    const input = withModels(connected, "codex", [{ id: "v4-pro", label: "V4 Pro" }], true);
    expect(input.agents.codex).toEqual({
      baseURL: "https://api.deepseek.com",
      protocol: "openai-compatible",
      models: [{ id: "v4-pro", label: "V4 Pro" }],
    });
    expect(input.agents.vgent?.models).toEqual([{ id: "v4-pro", label: "V4 Pro" }]);
    expect(input.agents["claude-code"]?.models).toEqual([]);
  });

  it("reads a switch, filters rows, and sums a provider up", () => {
    expect(isEnabled(connected, "vgent", "v4-pro")).toBe(true);
    expect(isEnabled(connected, "claude-code", "v4-pro")).toBe(false);
    expect(agentsOf(connected)).toEqual(["vgent", "claude-code"]);
    expect(filterModels([{ id: "v4-pro", label: "旗舰" }, { id: "v4-flash" }], "旗")).toEqual([{ id: "v4-pro", label: "旗舰" }]);
    expect(filterModels([{ id: "v4-pro" }, { id: "v4-flash" }], "FLASH")).toEqual([{ id: "v4-flash" }]);
    expect(summarizeEnabled(connected, (agent) => (agent === "vgent" ? "自研" : "Claude Code"))).toBe("自研 1 · Claude Code 0");
  });
});

describe("filterCatalog / formatContext", () => {
  it("matches a provider by name or id", () => {
    expect(filterCatalog([deepseek, azure], "DEEP").map((entry) => entry.id)).toEqual(["deepseek"]);
    expect(filterCatalog([deepseek, azure], "").length).toBe(2);
  });

  it("offers only what can be connected, by name", () => {
    const vertex: CatalogProviderSummary = { ...azure, id: "google-vertex", name: "Vertex", unsupported: "要 Google Cloud 凭据" };
    expect(connectableCatalog([ollama, vertex, deepseek, azure]).map((entry) => entry.id)).toEqual(["azure", "deepseek", "ollama"]);
    expect(connectableCatalog([ollama, vertex, deepseek, azure], "o").map((entry) => entry.id)).toEqual(["ollama"]);
  });

  it("writes a context window the short way", () => {
    expect(formatContext(128000)).toBe("128K");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(undefined)).toBe("");
  });
});

describe("订阅", () => {
  const labelOf = (agent: string) => (agent === "vgent" ? "自研" : agent === "codex" ? "Codex" : "Claude Code");
  const codex: SubscriptionAccount = {
    id: "codex-subscription",
    accountId: "codex",
    kind: "codex",
    name: "Codex · dev@example.com",
    email: "dev@example.com",
    plan: "pro",
    agents: ["vgent", "codex"],
    models: [
      { id: "gpt-5.5", label: "GPT-5.5", agents: { vgent: { spec: "codex-subscription:gpt-5.5", enabled: true }, codex: { spec: "gpt-5.5", enabled: true } } },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", agents: { vgent: { spec: "codex-subscription:gpt-5.5-mini", enabled: false }, codex: { spec: "gpt-5.5-mini", enabled: true } } },
    ],
  };

  it("lists「已添加」in 提供商排序, logins and providers alike; the ones never placed follow", () => {
    const claude: SubscriptionAccount = { ...codex, id: "claude-subscription", name: "Claude 订阅" };
    const other: RedactedProviderConfig = { ...connected, id: "xd", name: "XD" };
    const keys = (order?: string[]) => orderAdded([codex, claude], [connected, other], order).map((entry) => entry.key);
    expect(keys()).toEqual(["codex-subscription", "claude-subscription", "deepseek", "xd"]);
    expect(keys(["xd", "claude-subscription", "gone"])).toEqual(["xd", "claude-subscription", "codex-subscription", "deepseek"]);
  });

  it("keeps a signed-out login's place when the rows on screen are dragged", () => {
    expect(withShownOrder(["codex-subscription", "deepseek", "xd"], ["xd", "deepseek"])).toEqual(["codex-subscription", "xd", "deepseek"]);
    expect(withShownOrder(["deepseek"], ["xd", "deepseek", "claude-subscription"])).toEqual(["xd", "deepseek", "claude-subscription"]);
    expect(withShownOrder(undefined, ["xd", "deepseek"])).toEqual(["xd", "deepseek"]);
  });

  it("says the plan, and how it signs in when that is not the subscription; who it is, is in the name", () => {
    expect(describeSubscription(codex)).toBe("Pro");
    const { plan: _plan, ...bare } = codex;
    expect(describeSubscription(bare)).toBeUndefined();
    expect(describeSubscription({ ...codex, method: "api_key" })).toBe("Pro · 登录方式：api_key");
  });

  it("toggles only matching subscription models and preserves the other engine", () => {
    const matching = filterModels(codex.models, " MINI ");
    const on = withSubscriptionSwitch(codex.models, "vgent", matching.map(model => model.id), true);
    expect(on.map(model => model.agents.vgent?.enabled)).toEqual([true, true]);
    const off = withSubscriptionSwitch(on, "vgent", matching.map(model => model.id), false);
    expect(off).toEqual(codex.models);
  });

  it("sums up what each agent has on, and flips one agent's switch without touching the other's", () => {
    expect(summarizeSubscription(codex, labelOf)).toBe("自研 1 · Codex 2");
    const next = withSubscriptionSwitch(codex.models, "codex", ["gpt-5.5", "gpt-5.5-mini"], false);
    expect(next.map((model) => [model.agents.vgent?.enabled, model.agents.codex?.enabled])).toEqual([
      [true, false],
      [false, false],
    ]);
    // An agent the login does not serve has no cell to flip.
    expect(withSubscriptionSwitch(codex.models, "claude-code", ["gpt-5.5"], false)).toEqual(codex.models);
  });
});

describe("withAgentChoices", () => {
  const own = { baseURL: "https://gw.example/v1", protocol: "openai-compatible" as const, models: [{ id: "gpt-6-astra" }] };
  const all = ["vgent", "claude-code", "codex"] as const;

  it("adds Codex on the shared address and Claude Code on its own, starting with nothing ticked", () => {
    const result = withAgentChoices({ vgent: own }, { codex: true, claudeBaseURL: "https://gw.example/anthropic/" }, all);
    expect(result).toEqual({
      agents: {
        vgent: own,
        codex: { baseURL: "https://gw.example/v1", protocol: "openai", models: [] },
        "claude-code": { baseURL: "https://gw.example/anthropic", protocol: "anthropic", models: [] },
      },
    });
  });

  it("keeps an agent's ticked models when it stays, drops it when switched off, and refuses a bad address", () => {
    const codex = { baseURL: "https://old.example/v1", protocol: "openai" as const, models: [{ id: "gpt-6-astra" }] };
    expect(withAgentChoices({ vgent: own, codex }, { codex: true, claudeBaseURL: "" }, all)).toEqual({ agents: { vgent: own, codex } });
    expect(withAgentChoices({ vgent: own, codex }, { codex: false, claudeBaseURL: "" }, all)).toEqual({ agents: { vgent: own } });
    expect(withAgentChoices({ vgent: own }, { codex: false, claudeBaseURL: "not a url" }, all)).toHaveProperty("error");
    // The shared address changed in the same edit: a Codex that followed it follows on, one with its own stays put.
    const moved = { ...own, baseURL: "https://new.example/v1" };
    expect(withAgentChoices({ vgent: moved, codex: { ...codex, baseURL: own.baseURL } }, { codex: true, claudeBaseURL: "" }, all, { vgent: own, codex: { ...codex, baseURL: own.baseURL } })).toEqual({
      agents: { vgent: moved, codex: { ...codex, baseURL: moved.baseURL } },
    });
    expect(withAgentChoices({ vgent: moved, codex }, { codex: true, claudeBaseURL: "" }, all, { vgent: own, codex })).toEqual({ agents: { vgent: moved, codex } });
    // An engine this install does not have is not touched.
    expect(withAgentChoices({ vgent: own }, { codex: true, claudeBaseURL: "" }, ["vgent"])).toEqual({ agents: { vgent: own } });
  });
});
