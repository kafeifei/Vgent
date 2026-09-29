import { createOpenAI } from "@ai-sdk/openai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createModelRegistry } from "./model-registry.js";
import type { ProviderConfig, ProviderProtocol } from "./provider-config.js";
import { createOpenAIToolSearch } from "./tool-search.js";

function configured(id = "custom-official", baseURL = "https://api.openai.com/v1", protocol: ProviderProtocol = "openai") {
  const providers: ProviderConfig[] = [{ id, name: id, apiKey: "fake-key", agents: {
    vgent: { protocol, baseURL, models: [] },
  } }];
  const registry = createModelRegistry({ providers });
  return { providers, model: (modelId = "gpt-6-astra") => registry.languageModel(`${id}:${modelId}`) };
}

const hosted = { type: "provider", id: "openai.tool_search", args: {} };

describe("createOpenAIToolSearch", () => {
  it.each(["gpt-5.4", "gpt-5.5", "gpt-6-astra"])("enables only verified model %s on official and internal endpoints", (modelId) => {
    for (const baseURL of ["https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
      const { providers, model } = configured("custom-official", baseURL);
      expect(createOpenAIToolSearch(model(modelId), providers)).toMatchObject(hosted);
    }
    const model = createModelRegistry().languageModel(`codex-subscription:${modelId}`);
    expect(createOpenAIToolSearch(model)).toMatchObject(hosted);
  });

  it.each([
    "https://third-party.example/v1", "https://api.openai.com.evil.example/v1",
    "http://api.openai.com/v1", "https://api.openai.com/v2", "https://api.openai.com/v1/responses",
    "https://api.openai.com:444/v1", "https://user@api.openai.com/v1", "https://:password@api.openai.com/v1",
    "https://api.openai.com/v1?query=yes", "https://api.openai.com/v1#hash", "not-a-url",
  ])("rejects an openai-named provider at %s", (baseURL) => {
    const { providers, model } = configured("openai", baseURL);
    expect(createOpenAIToolSearch(model(), providers)).toBeUndefined();
  });

  it("rejects gateway, chat, unknown and raw unconfigured models", () => {
    expect(createOpenAIToolSearch(undefined)).toBeUndefined();
    expect(createOpenAIToolSearch("openai/gpt-6-astra")).toBeUndefined();
    expect(createOpenAIToolSearch(createModelRegistry().languageModel("openai/gpt-6-astra"))).toBeUndefined();
    const raw = createOpenAI({ apiKey: "fake-key" });
    expect(createOpenAIToolSearch(raw.responses("gpt-6-astra"))).toBeUndefined();
    const { providers, model } = configured("openai");
    expect(createOpenAIToolSearch(raw.chat("gpt-6-astra"), providers)).toBeUndefined();
    expect(createOpenAIToolSearch(model())).toBeUndefined();
    expect(createOpenAIToolSearch(new MockLanguageModelV3({ provider: "unknown.responses", modelId: "gpt-6-astra" }), providers)).toBeUndefined();
    const compatible = configured("openai", "https://api.openai.com/v1", "openai-compatible");
    expect(createOpenAIToolSearch(compatible.model(), compatible.providers)).toBeUndefined();
    expect(createOpenAIToolSearch(model(), compatible.providers)).toBeUndefined();
  });

  it.each(["gpt-4.1", "gpt-5", "gpt-5.3-codex", "gpt-6", "gpt-7", "gpt-5.4-mini", "gpt-5.5-2026-09-01", "gpt-6-astra-preview", "custom"])("rejects unverified model %s", (modelId) => {
    const { providers, model } = configured();
    expect(createOpenAIToolSearch(model(modelId), providers)).toBeUndefined();
    expect(createOpenAIToolSearch(createModelRegistry().languageModel(`codex-subscription:${modelId}`))).toBeUndefined();
  });
});
