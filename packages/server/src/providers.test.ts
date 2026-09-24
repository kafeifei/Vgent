import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { providerRoute } from "./engines/claude-code.js";
import { codexProviderRoute } from "./engines/codex.js";
import { createProviderStore } from "./store/providers.js";

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";
const SECRET = "sk-super-secret-value";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-providers-"));
  dirs.push(dir);
  return dir;
}

/** Claude Code's model list reads the provider catalog; unless a test answers for models.dev, nothing goes there. */
const offlineCatalog: typeof globalThis.fetch = async () => {
  throw new Error("offline in tests");
};

function makeApp(dataDir: string, providerFetch?: typeof globalThis.fetch): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN, catalogFetch: offlineCatalog, ...(providerFetch != null ? { providerFetch } : {}) });
  apps.push(instance);
  return instance;
}

function request(app: VgentApp, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    method: init?.method ?? "GET",
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const deepseekInput = {
  name: "DeepSeek",
  presetId: "deepseek",
  apiKey: SECRET,
  agents: {
    vgent: { baseURL: "https://api.deepseek.com", protocol: "openai-compatible", models: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000 }] },
    "claude-code": { baseURL: "https://api.deepseek.com/anthropic", models: [{ id: "deepseek-v4-flash" }] },
  },
};

describe("provider store", () => {
  it("writes the key to a 0600 file and gives ids that do not collide", async () => {
    const dir = await tempDir();
    const store = createProviderStore(dir);

    const first = await store.create({ name: "DeepSeek", presetId: "deepseek", apiKey: SECRET, agents: {} });
    const second = await store.create({ name: "DeepSeek 备用", presetId: "deepseek", agents: {} });

    expect(first.id).toBe("deepseek");
    expect(second.id).toBe("deepseek-2");
    expect((await stat(join(dir, "providers.json"))).mode & 0o777).toBe(0o600);
    // A second store instance on the same directory sees what the first wrote.
    expect((await createProviderStore(dir).get("deepseek"))?.apiKey).toBe(SECRET);
  });

  it("keeps, replaces or clears the key on update, by how the field is sent", async () => {
    const store = createProviderStore(await tempDir());
    const { id } = await store.create({ name: "P", apiKey: SECRET, agents: {} });

    expect((await store.update(id, { name: "P2", agents: {} })).apiKey).toBe(SECRET);
    expect((await store.update(id, { name: "P2", apiKey: "sk-new", agents: {} })).apiKey).toBe("sk-new");
    expect((await store.update(id, { name: "P2", apiKey: "", agents: {} })).apiKey).toBeUndefined();
  });

  it("does not lose a change when several land at once", async () => {
    const store = createProviderStore(await tempDir());
    await Promise.all(Array.from({ length: 8 }, (_, n) => store.create({ name: `p${n}`, agents: {} })));
    expect(await store.list()).toHaveLength(8);
  });

  it("refuses an id that is taken or built in", async () => {
    const store = createProviderStore(await tempDir());
    await store.create({ id: "mine", name: "Mine", agents: {} });
    await expect(store.create({ id: "mine", name: "Again", agents: {} })).rejects.toMatchObject({ status: 409 });
    await expect(store.create({ id: "gateway", name: "G", agents: {} })).rejects.toMatchObject({ status: 409 });
  });
});

describe("provider routes", () => {
  it("creates, lists, updates and deletes — and the key never comes back out", async () => {
    const dir = await tempDir();
    const app = makeApp(dir);

    const created = await request(app, "/api/providers", { method: "POST", body: deepseekInput });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain(SECRET);
    expect(JSON.parse(createdText)).toMatchObject({ id: "deepseek", hasKey: true, agents: { "claude-code": { protocol: "anthropic" } } });

    const listedText = await (await request(app, "/api/providers")).text();
    expect(listedText).not.toContain(SECRET);
    const listed = JSON.parse(listedText) as { providers: { id: string }[] };
    expect(listed.providers.map((provider) => provider.id)).toEqual(["deepseek"]);

    // An edit that does not mention the key keeps it.
    const patched = await request(app, "/api/providers/deepseek", { method: "PATCH", body: { ...deepseekInput, apiKey: undefined, name: "DeepSeek 主账号" } });
    expect(await patched.json()).toMatchObject({ name: "DeepSeek 主账号", hasKey: true });
    expect(await readFile(join(dir, "providers.json"), "utf8")).toContain(SECRET);

    // Neither the settings route nor the state stream knows providers exist.
    expect(await (await request(app, "/api/settings")).text()).not.toContain(SECRET);

    expect((await request(app, "/api/providers/deepseek", { method: "DELETE" })).status).toBe(204);
    expect((await request(app, "/api/providers/deepseek", { method: "DELETE" })).status).toBe(404);
  });

  it("answers a malformed body with what is wrong", async () => {
    const app = makeApp(await tempDir());
    const response = await request(app, "/api/providers", { method: "POST", body: { name: "X", agents: { vgent: { baseURL: "nope", models: [] } } } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_provider" } });
  });

  it("lists each engine's provider models under `<provider>:<model>`, and only for the engines the provider has an address for", async () => {
    // No Codex login, no gateway key, no Anthropic key: every engine's own list
    // stays builtin, so the route answers without touching the network.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODEX_HOME", await tempDir());
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const app = makeApp(await tempDir());
    await request(app, "/api/providers", { method: "POST", body: deepseekInput });

    const vgent = (await (await request(app, "/api/engines/vgent/models")).json()) as { models: { id: string; provider?: string; contextWindow?: number }[] };
    // A provider's model arrives with its 推理强度 like any other: the levels follow from how the engine carries the effort.
    expect(vgent.models).toContainEqual({
      id: "deepseek:deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      provider: "DeepSeek",
      contextWindow: 1_000_000,
      // Known only by its 1M window, so a shorter one is offered beside it.
      contextOptions: [300_000, 1_000_000],
      // The same key under every agent it is switched on for: the picker shows it once.
      modelKey: "deepseek/deepseek-v4-pro",
      // In the catalog, so it has a logo to show.
      source: { kind: "provider", id: "deepseek", name: "DeepSeek", logo: "deepseek" },
      // Who made it, which is what picks its default engine.
      vendor: "deepseek",
      reasoningLevels: ["provider-default", "low", "medium", "high"],
      defaultReasoningLevel: "high",
    });

    const claude = (await (await request(app, "/api/engines/claude-code/models")).json()) as { models: { id: string }[] };
    expect(claude.models.map((model) => model.id)).toContain("deepseek:deepseek-v4-flash");
    expect(claude.models.map((model) => model.id)).not.toContain("deepseek:deepseek-v4-pro");

    const codex = (await (await request(app, "/api/engines/codex/models")).json()) as { models: { id: string }[] };
    expect(codex.models.some((model) => model.id.startsWith("deepseek:"))).toBe(false);

    const engines = (await (await request(app, "/api/engines")).json()) as { engines: { id: string; capabilities: { customProviders: boolean } }[] };
    expect(Object.fromEntries(engines.engines.map((engine) => [engine.id, engine.capabilities.customProviders]))).toEqual({
      "claude-code": true,
      codex: true,
      vgent: true,
    });
  });

  it("offers Codex a provider's models once the provider has a Codex address, under the Responses protocol whatever was sent", async () => {
    vi.stubEnv("CODEX_HOME", await tempDir());
    const app = makeApp(await tempDir());
    const created = await request(app, "/api/providers", {
      method: "POST",
      body: { name: "OpenAI", presetId: "openai", apiKey: SECRET, agents: { codex: { baseURL: "https://api.openai.com/v1", protocol: "anthropic", models: [{ id: "gpt-5.4", label: "GPT-5.4" }] } } },
    });
    expect(((await created.json()) as { agents: { codex: { protocol: string } } }).agents.codex.protocol).toBe("openai");
    const codex = (await (await request(app, "/api/engines/codex/models")).json()) as { models: { id: string; provider?: string }[] };
    expect(codex.models).toContainEqual({
      id: "openai:gpt-5.4",
      label: "GPT-5.4",
      provider: "OpenAI",
      modelKey: "openai/gpt-5.4",
      source: { kind: "provider", id: "openai", name: "OpenAI" },
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoningLevel: "high",
    });
  });

  it("pulls a provider's model list with the form's key, or the stored one when the form has none", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const providerFetch: typeof globalThis.fetch = async (input, init) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] }), { status: 200 });
    };
    const app = makeApp(await tempDir(), providerFetch);
    await request(app, "/api/providers", { method: "POST", body: deepseekInput });

    const unsaved = await request(app, "/api/providers/discover", { method: "POST", body: { baseURL: "https://api.deepseek.com", apiKey: "sk-typed" } });
    expect(await unsaved.json()).toEqual({ models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] });

    await request(app, "/api/providers/discover", { method: "POST", body: { providerId: "deepseek", baseURL: "https://api.deepseek.com" } });

    expect(seen).toEqual([
      { url: "https://api.deepseek.com/models", authorization: "Bearer sk-typed" },
      { url: "https://api.deepseek.com/models", authorization: `Bearer ${SECRET}` },
    ]);
  });

  it("turns a provider's refusal into a 502 that says why, without the key", async () => {
    const app = makeApp(await tempDir(), async () => new Response("{}", { status: 401 }));
    const response = await request(app, "/api/providers/discover", { method: "POST", body: { baseURL: "https://x.test", apiKey: SECRET } });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("key 不对");
    expect(text).not.toContain(SECRET);
    // Its own code: connecting stops on a refused key, and shrugs off every other listing failure.
    expect(JSON.parse(text)).toMatchObject({ error: { code: "provider_key_rejected" } });

    const missing = makeApp(await tempDir(), async () => new Response("{}", { status: 404 }));
    const notFound = await request(missing, "/api/providers/discover", { method: "POST", body: { baseURL: "https://x.test" } });
    expect(await notFound.json()).toMatchObject({ error: { code: "provider_discovery_failed" } });
  });

  it("accepts a vendor's own protocol, and refuses one it has never heard of", async () => {
    const app = makeApp(await tempDir());
    const xai = { name: "xAI", presetId: "xai", apiKey: SECRET, agents: { vgent: { baseURL: "https://api.x.ai/v1", protocol: "xai", models: [] } } };
    expect((await request(app, "/api/providers", { method: "POST", body: xai })).status).toBe(201);
    const bogus = { ...xai, name: "Bogus", agents: { vgent: { baseURL: "https://x.test", protocol: "telepathy", models: [] } } };
    expect((await request(app, "/api/providers", { method: "POST", body: bogus })).status).toBe(400);
  });
});

describe("subscription logout route", () => {
  it("calls only the selected vendor after an authenticated request", async () => {
    const ids: string[] = [];
    const app = createApp({
      dataDir: await tempDir(), token: TOKEN, catalogFetch: offlineCatalog,
      logoutSubscription: async (id) => { ids.push(id); },
    });
    apps.push(app);
    expect((await request(app, "/api/subscriptions/claude-subscription/logout", { method: "POST" })).status).toBe(200);
    expect((await request(app, "/api/subscriptions/codex-subscription/logout", { method: "POST" })).status).toBe(200);
    expect((await request(app, "/api/subscriptions/unknown/logout", { method: "POST" })).status).toBe(404);
    expect(ids).toEqual(["claude-subscription", "codex-subscription"]);
    expect((await app.app.request(`${ORIGIN}/api/subscriptions/claude-subscription/logout`, { method: "POST" })).status).toBe(401);
    expect(ids).toHaveLength(2);
  });
});

describe("provider catalog", () => {
  const MODELS_DEV = {
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.deepseek.com",
      models: { "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", tool_call: true, limit: { context: 128000 } } },
    },
    venice: { id: "venice", name: "Venice", npm: "venice-ai-sdk-provider", models: {} },
  };

  function catalogApp(dataDir: string, catalogFetch: typeof globalThis.fetch): VgentApp {
    const instance = createApp({ dataDir, token: TOKEN, catalogFetch });
    apps.push(instance);
    return instance;
  }

  it("serves models.dev without the models, the popular ids that exist, and one provider's models on request", async () => {
    let downloads = 0;
    const dir = await tempDir();
    const app = catalogApp(dir, async () => {
      downloads += 1;
      return new Response(JSON.stringify(MODELS_DEV), { status: 200 });
    });

    const listing = (await (await request(app, "/api/providers/catalog")).json()) as {
      source: string;
      popular: string[];
      providers: { id: string; modelCount: number; models?: unknown; unsupported?: string }[];
    };
    expect(listing.source).toBe("live");
    expect(listing.popular).toEqual(["deepseek"]);
    expect(listing.providers.find((entry) => entry.id === "deepseek")).toMatchObject({ modelCount: 1 });
    expect(listing.providers.every((entry) => entry.models === undefined)).toBe(true);
    expect(listing.providers.find((entry) => entry.id === "venice")?.unsupported).toBeDefined();

    const one = await request(app, "/api/providers/catalog/deepseek");
    expect(await one.json()).toMatchObject({
      agents: { vgent: { protocol: "openai-compatible", baseURL: "https://api.deepseek.com" }, "claude-code": { baseURL: "https://api.deepseek.com/anthropic" } },
      models: [{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 128000 }],
    });
    expect((await request(app, "/api/providers/catalog/nope")).status).toBe(404);

    // Asked three times, downloaded once; and a second process starts from the file on disk.
    expect(downloads).toBe(1);
    const restarted = catalogApp(dir, async () => {
      throw new Error("offline");
    });
    expect(await (await request(restarted, "/api/providers/catalog")).json()).toMatchObject({ source: "cache" });
  });

  it("falls back to the providers built into the app when models.dev has never been reachable", async () => {
    const app = catalogApp(await tempDir(), async () => {
      throw new Error("offline");
    });
    const listing = (await (await request(app, "/api/providers/catalog")).json()) as { source: string; providers: { id: string }[] };
    expect(listing.source).toBe("builtin");
    expect(listing.providers.map((entry) => entry.id)).toContain("openrouter");
  });

  it("downloads again when asked to", async () => {
    let downloads = 0;
    const app = catalogApp(await tempDir(), async () => {
      downloads += 1;
      return new Response(JSON.stringify(MODELS_DEV), { status: 200 });
    });
    await request(app, "/api/providers/catalog");
    await request(app, "/api/providers/catalog?refresh=1");
    expect(downloads).toBe(2);
  });
});

describe("providerRoute (Claude Code)", () => {
  const providers = [
    {
      id: "deepseek",
      name: "DeepSeek",
      apiKey: SECRET,
      agents: { "claude-code": { baseURL: "https://api.deepseek.com/anthropic", protocol: "anthropic" as const, models: [{ id: "deepseek-v4-pro" }] } },
    },
    { id: "vgent-only", name: "只给自研", agents: { vgent: { baseURL: "https://x.test", protocol: "openai-compatible" as const, models: [] } } },
  ];

  it("leaves the runtime's own model names alone", () => {
    expect(providerRoute(undefined, providers)).toBeUndefined();
    expect(providerRoute("sonnet", providers)).toBeUndefined();
    expect(providerRoute("claude-opus-5-20260101", providers)).toBeUndefined();
  });

  it("points the runtime at the provider and pins every model alias to the chosen one", () => {
    expect(providerRoute("deepseek:deepseek-v4-pro", providers)).toEqual({
      model: "deepseek-v4-pro",
      auth: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: SECRET },
      env: {
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
        CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-pro",
      },
    });
  });

  it("hands Anthropic's own API the key the way it takes it, and leaves its model aliases alone", () => {
    const anthropic = [
      { id: "anthropic", name: "Anthropic", apiKey: SECRET, agents: { "claude-code": { baseURL: "https://api.anthropic.com", protocol: "anthropic" as const, models: [{ id: "claude-sonnet-5" }] } } },
    ];
    expect(providerRoute("anthropic:claude-sonnet-5", anthropic)).toEqual({ model: "claude-sonnet-5", auth: { ANTHROPIC_API_KEY: SECRET }, env: {} });
  });

  it("refuses a provider that is gone or has no Claude Code endpoint", () => {
    expect(() => providerRoute("gone:model", providers)).toThrow(/可能已被删除/);
    expect(() => providerRoute("vgent-only:model", providers)).toThrow(/没有给 Claude Code/);
  });
});

describe("subscription routes", () => {
  // No Codex login and no keys in the environment, so every list is the builtin
  // one and nothing reaches the network; the Claude login is answered for.
  const quietEnv = async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODEX_HOME", await tempDir());
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
  };
  const makeSubscribedApp = (dataDir: string, catalogFetch: typeof globalThis.fetch = offlineCatalog): VgentApp => {
    const instance = createApp({ dataDir, token: TOKEN, catalogFetch, probeClaudeLogin: async () => ({ loggedIn: true, email: "dev@example.com", plan: "max" }) });
    apps.push(instance);
    return instance;
  };
  type Listed = { subscriptions: { id: string; loggedIn?: boolean; email?: string; agents: string[]; models: { id: string; agents: Record<string, { spec: string; enabled: boolean }> }[] }[] };

  it("lists the two logins with their state, every model on to begin with", async () => {
    await quietEnv();
    const app = makeSubscribedApp(await tempDir());
    const body = (await (await request(app, "/api/subscriptions")).json()) as Listed;
    expect(body.subscriptions.map((entry) => [entry.id, entry.loggedIn, entry.agents])).toEqual([
      ["claude-subscription", true, ["claude-code"]],
      ["codex-subscription", false, ["vgent", "codex"]],
    ]);
    expect(body.subscriptions[0]?.email).toBe("dev@example.com");
    expect(body.subscriptions[1]?.models).toEqual([
      { id: "gpt-5.5", label: "gpt-5.5", agents: { vgent: { spec: "codex-subscription:gpt-5.5", enabled: true }, codex: { spec: "gpt-5.5", enabled: true } } },
    ]);
  });

  it("gives Claude Code every Anthropic model the provider catalog knows, by full id, after the aliases", async () => {
    await quietEnv();
    const model = (id: string, name: string) => ({ id, name, tool_call: true, modalities: { input: ["text"], output: ["text"] } });
    const modelsDev = {
      anthropic: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", models: { "claude-opus-5": model("claude-opus-5", "Claude Opus 5"), "claude-haiku-4-5": model("claude-haiku-4-5", "Claude Haiku 4.5") } },
    };
    const app = makeSubscribedApp(await tempDir(), async () => new Response(JSON.stringify(modelsDev), { status: 200 }));
    const body = (await (await request(app, "/api/subscriptions")).json()) as Listed;
    const ids = body.subscriptions[0]?.models.map((entry) => entry.id) ?? [];
    expect(ids.slice(0, 3)).toEqual(["sonnet", "opus", "haiku"]);
    expect([...ids.slice(3)].sort()).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
  });

  it("a switch hides the model from that agent's picker only, survives a restart, and comes back on", async () => {
    await quietEnv();
    const dataDir = await tempDir();
    const app = makeSubscribedApp(dataDir);

    const off = await request(app, "/api/subscriptions/codex-subscription/models", { method: "PUT", body: { agent: "vgent", models: ["gpt-5.5"], enabled: false } });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { models: Listed["subscriptions"][number]["models"] }).models[0]?.agents).toEqual({
      vgent: { spec: "codex-subscription:gpt-5.5", enabled: false },
      codex: { spec: "gpt-5.5", enabled: true },
    });

    // Still listed, so「默认」keeps its label and window — but marked, and the picker leaves it out.
    const vgent = (await (await request(app, "/api/engines/vgent/models")).json()) as { models: { id: string; hidden?: boolean }[] };
    expect(vgent.models).toContainEqual(expect.objectContaining({ id: "codex-subscription:gpt-5.5", hidden: true }));
    const codex = (await (await request(app, "/api/engines/codex/models")).json()) as { models: { id: string; hidden?: boolean }[] };
    expect(codex.models.some((model) => model.hidden === true)).toBe(false);

    const settingsFile = JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")) as { hiddenModels?: unknown };
    expect(settingsFile.hiddenModels).toEqual({ vgent: ["codex-subscription:gpt-5.5"] });

    const on = await request(app, "/api/subscriptions/codex-subscription/models", { method: "PUT", body: { agent: "vgent", models: ["gpt-5.5"], enabled: true } });
    expect(((await on.json()) as { models: Listed["subscriptions"][number]["models"] }).models[0]?.agents.vgent?.enabled).toBe(true);
    expect("hiddenModels" in (JSON.parse(await readFile(join(dataDir, "settings.json"), "utf8")) as object)).toBe(false);
  });

  it("two switches clicked together both land", async () => {
    await quietEnv();
    const app = makeSubscribedApp(await tempDir());
    await Promise.all(
      ["sonnet", "opus"].map((model) => request(app, "/api/subscriptions/claude-subscription/models", { method: "PUT", body: { agent: "claude-code", models: [model], enabled: false } })),
    );
    const settings = (await (await request(app, "/api/settings")).json()) as { hiddenModels?: Record<string, string[]> };
    expect([...(settings.hiddenModels?.["claude-code"] ?? [])].sort()).toEqual(["opus", "sonnet"]);
  });

  it("ignores an agent the login does not serve, and refuses what it cannot read", async () => {
    await quietEnv();
    const app = makeSubscribedApp(await tempDir());
    await request(app, "/api/subscriptions/claude-subscription/models", { method: "PUT", body: { agent: "vgent", models: ["sonnet"], enabled: false } });
    expect(((await (await request(app, "/api/settings")).json()) as { hiddenModels?: unknown }).hiddenModels).toBeUndefined();

    expect((await request(app, "/api/subscriptions/nope/models", { method: "PUT", body: { agent: "vgent", models: [], enabled: true } })).status).toBe(404);
    expect((await request(app, "/api/subscriptions/codex-subscription/models", { method: "PUT", body: { agent: "vgent", models: ["gpt-5.5"] } })).status).toBe(400);
  });

  it("keeps a provider from taking a subscription's id", async () => {
    const app = makeSubscribedApp(await tempDir());
    const response = await request(app, "/api/providers", { method: "POST", body: { name: "claude-subscription", agents: { vgent: { baseURL: "https://gw.test/v1", models: [] } } } });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { id: string }).id).toBe("claude-subscription-2");
  });
});

describe("codexProviderRoute", () => {
  const providers = [
    { id: "openai", name: "OpenAI", apiKey: SECRET, agents: { codex: { baseURL: "https://api.openai.com/v1/", protocol: "openai" as const, models: [{ id: "gpt-5.4" }] } } },
    { id: "local", name: "本机", agents: { codex: { baseURL: "http://127.0.0.1:8000/v1", protocol: "openai" as const, models: [] } } },
    { id: "vgent-only", name: "只给自研", agents: { vgent: { baseURL: "https://x.test", protocol: "openai-compatible" as const, models: [] } } },
  ];

  it("leaves the login's own models alone", () => {
    expect(codexProviderRoute(undefined, providers)).toBeUndefined();
    expect(codexProviderRoute("gpt-5.5", providers)).toBeUndefined();
  });

  it("hands Codex the provider's endpoint and key, and the bare model id", () => {
    expect(codexProviderRoute("openai:gpt-5.4", providers)).toEqual({ model: "gpt-5.4", auth: { OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_API_KEY: SECRET } });
  });

  it("tells Codex the model's context window when the provider's list knows it", () => {
    const sized = [{ id: "gw", name: "网关", apiKey: SECRET, agents: { codex: { baseURL: "https://gw.test/v1", protocol: "openai" as const, models: [{ id: "big", contextWindow: 400_000 }] } } }];
    expect(codexProviderRoute("gw:big", sized)?.codexConfig).toEqual({ model_context_window: 400_000 });
    expect(codexProviderRoute("gw:other", sized)?.codexConfig).toBeUndefined();
  });

  it("still names a key for a keyless endpoint, because the bridge only builds the provider entry when there is one", () => {
    expect(codexProviderRoute("local:qwen", providers)?.auth).toEqual({ OPENAI_BASE_URL: "http://127.0.0.1:8000/v1", OPENAI_API_KEY: "unused" });
  });

  it("refuses a provider that is gone or has no Codex endpoint", () => {
    expect(() => codexProviderRoute("gone:model", providers)).toThrow(/可能已被删除/);
    expect(() => codexProviderRoute("vgent-only:model", providers)).toThrow(/没有给 Codex/);
  });
});
