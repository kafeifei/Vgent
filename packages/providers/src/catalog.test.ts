import { describe, expect, it } from "vitest";
import { POPULAR_PROVIDER_IDS, builtinCatalog, fetchProviderCatalog, normalizeModelsDev, summarizeCatalogProvider } from "./catalog.js";
import { SDK_KINDS, parseProviderInput } from "./provider-config.js";

const model = (extra: Record<string, unknown> = {}) => ({ tool_call: true, modalities: { input: ["text"], output: ["text"] }, ...extra });

/** A slice of models.dev's `api.json`, shaped like the real thing. */
const MODELS_DEV = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.deepseek.com",
    doc: "https://api-docs.deepseek.com",
    env: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-v4-pro": model({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", release_date: "2026-04-01", limit: { context: 128000 } }),
      "deepseek-v3": model({ id: "deepseek-v3", name: "DeepSeek V3", release_date: "2025-01-01" }),
      "deepseek-embed": { id: "deepseek-embed", tool_call: false },
      "deepseek-old": model({ id: "deepseek-old", status: "deprecated" }),
      "deepseek-image": model({ id: "deepseek-image", modalities: { output: ["image"] } }),
    },
  },
  xai: { id: "xai", name: "xAI", npm: "@ai-sdk/xai", models: { "grok-4": model({ id: "grok-4" }) } },
  minimax: { id: "minimax", name: "MiniMax", npm: "@ai-sdk/anthropic", api: "https://api.minimax.io/anthropic/v1", models: { m2: model({ id: "m2" }) } },
  azure: { id: "azure", name: "Azure", npm: "@ai-sdk/azure", models: { "gpt-5": model({ id: "gpt-5" }) } },
  "cloudflare-workers-ai": {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    models: {},
  },
  lmstudio: { id: "lmstudio", name: "LM Studio", npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:1234/v1", models: {} },
  "github-copilot": { id: "github-copilot", name: "GitHub Copilot", npm: "@ai-sdk/openai-compatible", api: "https://api.githubcopilot.com", models: {} },
  venice: { id: "venice", name: "Venice", npm: "venice-ai-sdk-provider", models: {} },
  broken: "not an object",
};

describe("normalizeModelsDev", () => {
  const catalog = normalizeModelsDev(MODELS_DEV);
  const byId = (id: string) => catalog.find((entry) => entry.id === id);

  it("keeps only the models an agent can use, newest first", () => {
    expect(byId("deepseek")?.models).toEqual([
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128000 },
      { id: "deepseek-v3", label: "DeepSeek V3" },
    ]);
  });

  it("maps the catalog's npm package to the protocol, and falls back to the package's own address", () => {
    expect(byId("xai")?.agents).toEqual({ vgent: { protocol: "xai", baseURL: SDK_KINDS.xai.defaultBaseURL } });
  });

  it("offers Claude Code the vendor's Anthropic endpoint: the same address for an Anthropic provider, Cindy's for the ones it knows", () => {
    // models.dev gives the AI SDK form (`…/v1`); what is stored is the `claude` CLI's form, without it.
    expect(byId("minimax")?.agents).toEqual({
      vgent: { protocol: "anthropic", baseURL: "https://api.minimax.io/anthropic" },
      "claude-code": { protocol: "anthropic", baseURL: "https://api.minimax.io/anthropic" },
    });
    expect(byId("deepseek")?.agents["claude-code"]).toEqual({ protocol: "anthropic", baseURL: "https://api.deepseek.com/anthropic" });
    expect(byId("xai")?.agents["claude-code"]).toBeUndefined();
  });

  it("asks for the address when it is the user's own", () => {
    expect(byId("azure")).toMatchObject({ agents: { vgent: { protocol: "azure" } }, baseURLHint: SDK_KINDS.azure.baseURLHint });
    expect(byId("azure")?.agents.vgent?.baseURL).toBeUndefined();
    const cloudflare = byId("cloudflare-workers-ai");
    expect(cloudflare?.agents.vgent?.baseURL).toBeUndefined();
    expect(cloudflare?.baseURLHint).toContain("${CLOUDFLARE_ACCOUNT_ID}");
  });

  it("lists what this build cannot connect, with the reason, instead of hiding it", () => {
    expect(byId("venice")).toMatchObject({ agents: {}, unsupported: expect.stringContaining("venice-ai-sdk-provider") });
    expect(byId("github-copilot")).toMatchObject({ agents: {}, unsupported: expect.stringContaining("GitHub") });
  });

  it("knows a server on this machine takes no key, and adds the local ones models.dev leaves out", () => {
    expect(byId("lmstudio")?.keyless).toBe(true);
    expect(byId("ollama")).toMatchObject({ keyless: true, agents: { vgent: { protocol: "openai-compatible" } } });
  });

  it("skips an entry it cannot read and refuses a payload that is not the catalog", () => {
    expect(byId("broken")).toBeUndefined();
    expect(() => normalizeModelsDev([])).toThrow();
    expect(() => normalizeModelsDev({})).toThrow();
  });

  it("every connectable entry with an address turns into a provider the config parser accepts", () => {
    for (const entry of catalog) {
      const agents = Object.fromEntries(
        Object.entries(entry.agents).flatMap(([agent, endpoint]) => (endpoint.baseURL == null ? [] : [[agent, { ...endpoint, models: entry.models }]])),
      );
      if (Object.keys(agents).length === 0) continue;
      expect(() => parseProviderInput({ name: entry.name, presetId: entry.id, agents })).not.toThrow();
    }
  });

  it("summarises without the models", () => {
    const summary = summarizeCatalogProvider(byId("deepseek")!);
    expect(summary).toMatchObject({ id: "deepseek", modelCount: 2 });
    expect("models" in summary).toBe(false);
  });
});

describe("builtinCatalog", () => {
  it("is Cindy's presets plus the local servers: what is left when models.dev was never reachable", () => {
    const ids = builtinCatalog().map((entry) => entry.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("ollama");
    const deepseek = builtinCatalog().find((entry) => entry.id === "deepseek");
    expect(deepseek?.agents.vgent?.baseURL).toBe("https://api.deepseek.com");
    expect(deepseek?.models.length).toBeGreaterThan(0);
  });
});

describe("fetchProviderCatalog", () => {
  it("downloads models.dev and normalizes it", async () => {
    const seen: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify(MODELS_DEV), { status: 200 });
    };
    const catalog = await fetchProviderCatalog({ fetch });
    expect(seen).toEqual(["https://models.dev/api.json"]);
    expect(catalog.some((entry) => entry.id === "deepseek")).toBe(true);
  });

  it("throws when models.dev does not answer properly, so the caller falls back", async () => {
    await expect(fetchProviderCatalog({ fetch: async () => new Response("nope", { status: 503 }) })).rejects.toThrow(/503/);
  });
});

describe("POPULAR_PROVIDER_IDS", () => {
  it("names ids, never anything that would need a catalog to be bundled", () => {
    expect(new Set(POPULAR_PROVIDER_IDS).size).toBe(POPULAR_PROVIDER_IDS.length);
  });
});
