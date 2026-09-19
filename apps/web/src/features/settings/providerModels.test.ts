import { describe, expect, it } from "vitest";
import { splitByProvider } from "@/components/ModelPicker";
import type { CatalogProviderSummary, RedactedProviderConfig } from "@/lib/types";
import {
  EMPTY_CUSTOM_FORM,
  agentsOf,
  connectInput,
  customInput,
  filterCatalog,
  filterModels,
  formatContext,
  isEnabled,
  modelRows,
  summarizeEnabled,
  withModels,
} from "./providerModels";

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

  it("writes a context window the short way", () => {
    expect(formatContext(128000)).toBe("128K");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(undefined)).toBe("");
  });
});

describe("splitByProvider", () => {
  it("keeps an engine's own models first and groups the rest under their provider, in first-seen order", () => {
    const rows = [{ id: "sonnet" }, { id: "kimi:k3", provider: "Kimi" }, { id: "deepseek:pro", provider: "DeepSeek" }, { id: "opus" }, { id: "kimi:k2", provider: "Kimi" }];
    expect(splitByProvider(rows)).toEqual({
      own: [{ id: "sonnet" }, { id: "opus" }],
      fromProviders: [
        ["Kimi", [{ id: "kimi:k3", provider: "Kimi" }, { id: "kimi:k2", provider: "Kimi" }]],
        ["DeepSeek", [{ id: "deepseek:pro", provider: "DeepSeek" }]],
      ],
    });
  });
});
