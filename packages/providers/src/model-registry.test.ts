import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { anthropicSdkBaseURL, bedrockRegionOf, createModelRegistry, describeModelSpec } from "./model-registry.js";
import { PROVIDER_PROTOCOLS, SDK_KINDS, type ProviderConfig, type ProviderProtocol } from "./provider-config.js";

const deepseek: ProviderConfig = {
  id: "deepseek",
  name: "DeepSeek",
  apiKey: "sk-deepseek",
  agents: {
    vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "deepseek-v4-pro" }] },
    "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic", models: [{ id: "deepseek-v4-pro" }] },
  },
};

const kimi: ProviderConfig = {
  id: "kimi",
  name: "Kimi",
  apiKey: "sk-kimi",
  agents: { vgent: { baseURL: "https://api.moonshot.cn/anthropic", protocol: "anthropic", models: [{ id: "kimi-k3" }] } },
};

const claudeOnly: ProviderConfig = {
  id: "cc-only",
  name: "只给 Claude Code",
  apiKey: "sk-cc",
  agents: { "claude-code": { baseURL: "https://example.com/anthropic", protocol: "anthropic", models: [{ id: "m" }] } },
};

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records the request and answers like the named protocol would. */
function fakeFetch(seen: Seen[]): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const payload = url.endsWith("/messages")
      ? {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "kimi-k3",
          content: [{ type: "text", text: "来自 anthropic 协议" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      : {
          id: "chatcmpl_1",
          object: "chat.completion",
          created: 0,
          model: "deepseek-v4-pro",
          choices: [{ index: 0, message: { role: "assistant", content: "来自 openai 兼容协议" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

describe("describeModelSpec", () => {
  it("routes the three spellings", () => {
    expect(describeModelSpec("codex-subscription:gpt-5.5")).toEqual({ kind: "codex-subscription", modelId: "gpt-5.5" });
    expect(describeModelSpec("anthropic/claude-sonnet-5")).toEqual({ kind: "gateway", modelId: "anthropic/claude-sonnet-5" });
    expect(describeModelSpec("gateway:openai/gpt-5.5")).toEqual({ kind: "gateway", modelId: "openai/gpt-5.5" });
    expect(describeModelSpec("deepseek:deepseek-v4-pro", [deepseek])).toMatchObject({ kind: "provider", modelId: "deepseek-v4-pro" });
  });

  it("keeps a model id's own colons and slashes", () => {
    expect(describeModelSpec("deepseek:org/model:free", [deepseek])).toMatchObject({ kind: "provider", modelId: "org/model:free" });
  });

  it("says why a spec cannot run", () => {
    expect(describeModelSpec("codex-subscription:")).toMatchObject({ kind: "invalid" });
    expect(describeModelSpec("gone:some-model", [deepseek])).toMatchObject({ kind: "invalid", reason: expect.stringContaining("gone") });
    expect(describeModelSpec("cc-only:m", [claudeOnly])).toMatchObject({ kind: "invalid", reason: expect.stringContaining("自研引擎") });
    expect(describeModelSpec("just-a-word")).toMatchObject({ kind: "invalid" });
    expect(describeModelSpec("has space/model")).toMatchObject({ kind: "invalid" });
  });
});

describe("anthropicSdkBaseURL", () => {
  it("adds the version segment the claude CLI leaves off, once", () => {
    expect(anthropicSdkBaseURL("https://api.deepseek.com/anthropic")).toBe("https://api.deepseek.com/anthropic/v1");
    expect(anthropicSdkBaseURL("https://api.deepseek.com/anthropic/")).toBe("https://api.deepseek.com/anthropic/v1");
    expect(anthropicSdkBaseURL("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
  });
});

describe("createModelRegistry", () => {
  it("drives an OpenAI-compatible provider at its own endpoint with its own key", async () => {
    const seen: Seen[] = [];
    const registry = createModelRegistry({ providers: [deepseek, kimi], fetch: fakeFetch(seen) });

    const { text } = await generateText({ model: registry.languageModel("deepseek:deepseek-v4-pro"), prompt: "hi" });

    expect(text).toBe("来自 openai 兼容协议");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-deepseek");
    expect(seen[0]?.body.model).toBe("deepseek-v4-pro");
  });

  it("drives an Anthropic-compatible provider with the Bearer form the claude CLI uses", async () => {
    const seen: Seen[] = [];
    const registry = createModelRegistry({ providers: [deepseek, kimi], fetch: fakeFetch(seen) });

    const { text } = await generateText({ model: registry.languageModel("kimi:kimi-k3"), prompt: "hi" });

    expect(text).toBe("来自 anthropic 协议");
    expect(seen[0]?.url).toBe("https://api.moonshot.cn/anthropic/v1/messages");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-kimi");
    expect(seen[0]?.headers.get("x-api-key")).toBeNull();
    // Not the 4096 the SDK would silently fall back to for a model id it does not know.
    expect(seen[0]?.body.max_tokens).toBe(16_000);
  });

  it("resolves a model the user has not ticked yet through the fallback", async () => {
    const seen: Seen[] = [];
    const registry = createModelRegistry({ providers: [deepseek], fetch: fakeFetch(seen) });

    await generateText({ model: registry.languageModel("deepseek:deepseek-v4-flash"), prompt: "hi" });

    expect(seen[0]?.body.model).toBe("deepseek-v4-flash");
  });

  it("refuses a spec that names no source, with the reason", () => {
    const registry = createModelRegistry({ providers: [deepseek] });
    expect(() => registry.languageModel("gone:model")).toThrow(/gone/);
    expect(() => registry.languageModel("cc-only:m")).toThrow(/模型标识不合法/);
  });

  it("still serves the Codex login and the gateway with no providers configured", () => {
    const registry = createModelRegistry();
    expect(registry.languageModel("codex-subscription:gpt-5.5")).toMatchObject({ modelId: "gpt-5.5" });
    expect(registry.languageModel("openai/gpt-5.5")).toMatchObject({ modelId: "openai/gpt-5.5" });
  });
});

describe("every protocol", () => {
  const USER_OWNED: Partial<Record<ProviderProtocol, string>> = {
    "openai-compatible": "https://gateway.example.com/v1",
    azure: "https://my-resource.openai.azure.com/openai",
    "amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
  };

  // The vendors' response shapes all differ; what is ours to get right is the
  // request: the vendor's own package was built, pointed at the configured
  // address, and handed the key. So the fake refuses, and the request is read.
  it.each(PROVIDER_PROTOCOLS)("%s builds its own SDK provider, reaches the configured address, and sends the key", async (protocol) => {
    const baseURL = SDK_KINDS[protocol].defaultBaseURL ?? USER_OWNED[protocol];
    expect(baseURL, `${protocol} needs an address to test with`).toBeDefined();
    const seen: { url: string; headers: Headers }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ error: { message: "refused by the test" } }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const provider: ProviderConfig = { id: "p", name: "P", apiKey: "sk-the-key", agents: { vgent: { baseURL: baseURL!, protocol, models: [{ id: "some-model" }] } } };
    const model = createModelRegistry({ providers: [provider], fetch }).languageModel("p:some-model");

    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow();

    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).host).toBe(new URL(baseURL!).host);
    const sent = [...seen[0]!.headers.values()].join("\n");
    expect(sent).toContain("sk-the-key");
  });

  it("reads a Bedrock region out of its address", () => {
    expect(bedrockRegionOf("https://bedrock-runtime.eu-west-3.amazonaws.com")).toBe("eu-west-3");
    expect(bedrockRegionOf("https://example.com")).toBeUndefined();
  });
});
