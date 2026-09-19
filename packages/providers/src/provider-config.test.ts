import { describe, expect, it } from "vitest";
import { canDiscoverModels, discoverProviderModels, ModelDiscoveryError } from "./discover.js";
import { PROVIDER_PRESETS } from "./presets.js";
import { parseProviderInput, providerModelSpec, redactProvider, slugifyProviderId, splitProviderModelSpec } from "./provider-config.js";

describe("parseProviderInput", () => {
  const valid = {
    name: "  DeepSeek ",
    apiKey: " sk-1 ",
    agents: {
      vgent: { baseURL: "https://api.deepseek.com/", models: [{ id: "a" }, { id: "a" }, { id: "b", label: " B ", contextWindow: 1000 }] },
      "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "openai-compatible", models: [] },
    },
  };

  it("normalises what it accepts", () => {
    const parsed = parseProviderInput(valid);
    expect(parsed.name).toBe("DeepSeek");
    expect(parsed.apiKey).toBe("sk-1");
    // Trailing slash gone, protocol defaulted, duplicate model dropped, label trimmed.
    expect(parsed.agents.vgent).toEqual({
      baseURL: "https://api.deepseek.com",
      protocol: "openai-compatible",
      models: [{ id: "a" }, { id: "b", label: "B", contextWindow: 1000 }],
    });
    // Claude Code only ever speaks Anthropic Messages, whatever the body said.
    expect(parsed.agents["claude-code"]?.protocol).toBe("anthropic");
  });

  it("rejects what could not work", () => {
    expect(() => parseProviderInput({ ...valid, name: " " })).toThrow(/name/);
    expect(() => parseProviderInput({ ...valid, agents: {} })).toThrow(/至少/);
    expect(() => parseProviderInput({ ...valid, agents: { cursor: { baseURL: "https://x.test", models: [] } } })).toThrow(/未知的 agent/);
    expect(() => parseProviderInput({ ...valid, agents: { vgent: { baseURL: "ftp://x.test", models: [] } } })).toThrow(/http/);
    expect(() => parseProviderInput({ ...valid, agents: { vgent: { baseURL: "not a url", models: [] } } })).toThrow(/URL/);
    expect(() => parseProviderInput({ ...valid, id: "Codex Subscription" })).toThrow(/id/);
    expect(() => parseProviderInput({ ...valid, id: "codex-subscription" })).toThrow(/内置/);
  });
});

describe("provider ids and specs", () => {
  it("round-trips a spec and leaves the model id's own separators alone", () => {
    expect(splitProviderModelSpec(providerModelSpec("openrouter", "z-ai/glm-5.2:free"))).toEqual({ providerId: "openrouter", modelId: "z-ai/glm-5.2:free" });
    expect(splitProviderModelSpec("anthropic/claude")).toBeUndefined();
    expect(splitProviderModelSpec(":x")).toBeUndefined();
    expect(splitProviderModelSpec("x:")).toBeUndefined();
  });

  it("slugs a display name", () => {
    expect(slugifyProviderId("Kimi (Moonshot 中国大陆)")).toBe("kimi-moonshot");
    expect(slugifyProviderId("智谱")).toBe("provider");
  });

  it("never lets the key out", () => {
    const redacted = redactProvider({ id: "p", name: "P", apiKey: "sk-secret", agents: {} });
    expect(redacted).toEqual({ id: "p", name: "P", agents: {}, hasKey: true });
    expect(JSON.stringify(redacted)).not.toContain("sk-secret");
    expect(redactProvider({ id: "p", name: "P", agents: {} }).hasKey).toBe(false);
  });
});

describe("presets", () => {
  it("are all creatable as they stand", () => {
    expect(PROVIDER_PRESETS.length).toBeGreaterThan(0);
    for (const preset of PROVIDER_PRESETS) {
      expect(() => parseProviderInput({ id: preset.id, name: preset.name, agents: preset.agents })).not.toThrow();
      // Every preset serves both agents Vgent can point at a custom endpoint.
      expect(preset.agents.vgent?.protocol).toBe("openai-compatible");
      expect(preset.agents["claude-code"]?.protocol).toBe("anthropic");
    }
  });
});

describe("discoverProviderModels", () => {
  const answering = (status: number, body: unknown, seen: { url?: string; headers?: Headers } = {}): typeof globalThis.fetch => {
    return async (input, init) => {
      seen.url = String(input);
      seen.headers = new Headers(init?.headers);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
  };

  it("lists an OpenAI-compatible endpoint, with names and windows when it gives them", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const models = await discoverProviderModels({
      baseURL: "https://openrouter.ai/api/v1/",
      protocol: "openai-compatible",
      apiKey: "sk-or",
      fetch: answering(200, { data: [{ id: "z-ai/glm-5.2", name: "GLM 5.2", context_length: 200000 }, { id: "plain" }, { id: "plain" }, { nope: true }] }, seen),
    });
    expect(seen.url).toBe("https://openrouter.ai/api/v1/models");
    expect(seen.headers?.get("authorization")).toBe("Bearer sk-or");
    expect(models).toEqual([{ id: "z-ai/glm-5.2", label: "GLM 5.2", contextWindow: 200000 }, { id: "plain" }]);
  });

  it("lists Gemini its own way: the key in x-goog-api-key, ids without the models/ prefix, chat models only", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const models = await discoverProviderModels({
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      protocol: "google",
      apiKey: "g-key",
      fetch: answering(
        200,
        {
          models: [
            { name: "models/gemini-3-pro", displayName: "Gemini 3 Pro", inputTokenLimit: 1000000, supportedGenerationMethods: ["generateContent"] },
            { name: "models/embedding-001", displayName: "Embedding", supportedGenerationMethods: ["embedContent"] },
          ],
        },
        seen,
      ),
    });
    expect(seen.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect(seen.headers?.get("x-goog-api-key")).toBe("g-key");
    expect(seen.headers?.get("authorization")).toBeNull();
    expect(models).toEqual([{ id: "gemini-3-pro", label: "Gemini 3 Pro", contextWindow: 1000000 }]);
  });

  it("uses the listing path of a vendor whose OpenAI surface sits under a sub-path, and says so when a vendor has none", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await discoverProviderModels({ baseURL: "https://api.deepinfra.com/v1", protocol: "deepinfra", apiKey: "k", fetch: answering(200, { data: [] }, seen) });
    expect(seen.url).toBe("https://api.deepinfra.com/v1/openai/models");
    expect(canDiscoverModels("perplexity")).toBe(false);
    await expect(discoverProviderModels({ baseURL: "https://api.perplexity.ai", protocol: "perplexity", fetch: answering(200, {}) })).rejects.toBeInstanceOf(ModelDiscoveryError);
  });

  it("lists an Anthropic-compatible endpoint under /v1 with both credential headers", async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const models = await discoverProviderModels({
      baseURL: "https://api.anthropic.com",
      protocol: "anthropic",
      apiKey: "sk-ant",
      fetch: answering(200, { data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] }, seen),
    });
    expect(seen.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(seen.headers?.get("x-api-key")).toBe("sk-ant");
    expect(models).toEqual([{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }]);
  });

  it("explains a refusal without repeating the key", async () => {
    const attempt = discoverProviderModels({ baseURL: "https://x.test", protocol: "openai-compatible", apiKey: "sk-leak-me", fetch: answering(401, { error: "bad key sk-leak-me" }) });
    await expect(attempt).rejects.toBeInstanceOf(ModelDiscoveryError);
    await expect(attempt).rejects.toMatchObject({ status: 401, message: expect.not.stringContaining("sk-leak-me") });
  });

  it("says so when an endpoint has no listing", async () => {
    await expect(discoverProviderModels({ baseURL: "https://x.test/anthropic", protocol: "anthropic", fetch: answering(404, {}) })).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("不提供模型列表"),
    });
  });
});
