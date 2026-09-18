import { describe, expect, it } from "vitest";
import { splitByProvider } from "@/components/ModelPicker";
import type { ProviderPreset, RedactedProviderConfig } from "@/lib/types";
import { emptyProviderForm, formFromPreset, formFromProvider, mergeCandidates, summarizeAgents, toProviderInput, toggleModel, withDiscovered } from "./providerForm";

const preset: ProviderPreset = {
  id: "deepseek",
  name: "DeepSeek",
  agents: {
    vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "v4-flash" }, { id: "v4-pro", label: "V4 Pro" }] },
    "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic", models: [{ id: "v4-pro" }] },
  },
};

const usable = ["vgent", "claude-code"] as const;

describe("provider form", () => {
  it("a preset is one key away from saving: endpoints filled, every seed ticked", () => {
    const form = formFromPreset(preset);
    expect(form.agents.vgent).toMatchObject({ enabled: true, baseURL: "https://api.deepseek.com", selected: ["v4-flash", "v4-pro"] });
    expect(form.agents.codex.enabled).toBe(false);

    const result = toProviderInput({ ...form, apiKey: " sk-1 " }, usable);
    expect(result).toEqual({
      input: {
        name: "DeepSeek",
        presetId: "deepseek",
        apiKey: "sk-1",
        agents: {
          vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "v4-flash" }, { id: "v4-pro", label: "V4 Pro" }] },
          "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic", models: [{ id: "v4-pro" }] },
        },
      },
    });
  });

  it("an untouched key is not sent when editing, so the server keeps the one it has", () => {
    const stored: RedactedProviderConfig = {
      id: "deepseek",
      name: "DeepSeek",
      presetId: "deepseek",
      hasKey: true,
      agents: { vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "v4-pro", label: "V4 Pro" }] } },
    };
    const form = formFromProvider(stored, preset);

    // What was unticked is still offered, from the preset's seeds; Claude Code is off but pre-filled.
    expect(form.agents.vgent.candidates.map((model) => model.id)).toEqual(["v4-pro", "v4-flash"]);
    expect(form.agents.vgent.selected).toEqual(["v4-pro"]);
    expect(form.agents["claude-code"]).toMatchObject({ enabled: false, baseURL: "https://api.deepseek.com/anthropic" });

    const result = toProviderInput(form, usable);
    expect("input" in result && "apiKey" in result.input).toBe(false);
  });

  it("拉取 adds candidates and leaves the ticks alone; ticking keeps candidate order on save", () => {
    let block = formFromPreset(preset).agents.vgent;
    block = withDiscovered(block, [{ id: "v4-pro", label: "ignored: the known label wins" }, { id: "v5-preview", contextWindow: 1000 }]);
    expect(block.candidates).toEqual([{ id: "v4-flash" }, { id: "v4-pro", label: "V4 Pro" }, { id: "v5-preview", contextWindow: 1000 }]);
    expect(block.selected).toEqual(["v4-flash", "v4-pro"]);

    block = toggleModel(toggleModel(block, "v4-flash"), "v5-preview");
    const form = { ...formFromPreset(preset), agents: { ...formFromPreset(preset).agents, vgent: block } };
    const result = toProviderInput(form, usable);
    expect("input" in result && result.input.agents.vgent?.models.map((model) => model.id)).toEqual(["v4-pro", "v5-preview"]);
  });

  it("says what is missing instead of sending it", () => {
    expect(toProviderInput(emptyProviderForm(), usable)).toEqual({ error: "给提供商起个名字" });
    expect(toProviderInput({ ...emptyProviderForm(), name: "X" }, usable)).toEqual({ error: "至少启用一个 agent" });
    const form = formFromPreset(preset);
    expect(toProviderInput({ ...form, agents: { ...form.agents, vgent: { ...form.agents.vgent, selected: [] } } }, usable)).toEqual({ error: "已启用的 agent 至少勾选一个模型" });
    expect(toProviderInput({ ...form, agents: { ...form.agents, vgent: { ...form.agents.vgent, baseURL: "api.deepseek.com" } } }, usable)).toMatchObject({ error: expect.stringContaining("http") });
  });

  it("never sends a block for an engine that cannot take a provider", () => {
    const form = formFromPreset(preset);
    const withCodex = { ...form, agents: { ...form.agents, codex: { ...form.agents.vgent } } };
    const result = toProviderInput(withCodex, usable);
    expect("input" in result && Object.keys(result.input.agents)).toEqual(["vgent", "claude-code"]);
  });

  it("merges candidates without repeating an id", () => {
    expect(mergeCandidates([{ id: "a" }], [{ id: "a", label: "A" }, { id: "b" }])).toEqual([{ id: "a", label: "A" }, { id: "b" }]);
  });

  it("summarises a row by agent", () => {
    const provider: RedactedProviderConfig = { id: "p", name: "P", hasKey: true, agents: preset.agents };
    expect(summarizeAgents(provider, (agent) => (agent === "vgent" ? "自研" : "Claude Code"))).toBe("自研 2 个模型 · Claude Code 1 个模型");
  });
});

describe("splitByProvider", () => {
  it("keeps an engine's own models first and groups the rest under their provider, in first-seen order", () => {
    const rows = [
      { id: "sonnet" },
      { id: "kimi:k3", provider: "Kimi" },
      { id: "deepseek:pro", provider: "DeepSeek" },
      { id: "opus" },
      { id: "kimi:k2", provider: "Kimi" },
    ];
    expect(splitByProvider(rows)).toEqual({
      own: [{ id: "sonnet" }, { id: "opus" }],
      fromProviders: [
        ["Kimi", [{ id: "kimi:k3", provider: "Kimi" }, { id: "kimi:k2", provider: "Kimi" }]],
        ["DeepSeek", [{ id: "deepseek:pro", provider: "DeepSeek" }]],
      ],
    });
  });
});
