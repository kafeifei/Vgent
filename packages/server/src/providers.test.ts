import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { providerRoute } from "./engines/claude-code.js";
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

function makeApp(dataDir: string, providerFetch?: typeof globalThis.fetch): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN, ...(providerFetch != null ? { providerFetch } : {}) });
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
    const listed = JSON.parse(listedText) as { providers: { id: string }[]; presets: { id: string }[] };
    expect(listed.providers.map((provider) => provider.id)).toEqual(["deepseek"]);
    expect(listed.presets.map((preset) => preset.id)).toContain("openrouter");

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

  it("lists each engine's provider models under `<provider>:<model>`, and none for an engine that cannot use them", async () => {
    // No Codex login, no gateway key, no Anthropic key: every engine's own list
    // stays builtin, so the route answers without touching the network.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CODEX_HOME", await tempDir());
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const app = makeApp(await tempDir());
    await request(app, "/api/providers", { method: "POST", body: deepseekInput });

    const vgent = (await (await request(app, "/api/engines/vgent/models")).json()) as { models: { id: string; provider?: string; contextWindow?: number }[] };
    expect(vgent.models).toContainEqual({ id: "deepseek:deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "DeepSeek", contextWindow: 1_000_000 });

    const claude = (await (await request(app, "/api/engines/claude-code/models")).json()) as { models: { id: string }[] };
    expect(claude.models.map((model) => model.id)).toContain("deepseek:deepseek-v4-flash");
    expect(claude.models.map((model) => model.id)).not.toContain("deepseek:deepseek-v4-pro");

    const codex = (await (await request(app, "/api/engines/codex/models")).json()) as { models: { id: string }[] };
    expect(codex.models.some((model) => model.id.startsWith("deepseek:"))).toBe(false);

    const engines = (await (await request(app, "/api/engines")).json()) as { engines: { id: string; capabilities: { customProviders: boolean } }[] };
    expect(Object.fromEntries(engines.engines.map((engine) => [engine.id, engine.capabilities.customProviders]))).toEqual({
      "claude-code": true,
      codex: false,
      vgent: true,
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

  it("refuses a provider that is gone or has no Claude Code endpoint", () => {
    expect(() => providerRoute("gone:model", providers)).toThrow(/可能已被删除/);
    expect(() => providerRoute("vgent-only:model", providers)).toThrow(/没有给 Claude Code/);
  });
});
