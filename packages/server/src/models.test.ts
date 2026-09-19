import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelCatalog, type CodexCatalogModel, type GatewayModelSource } from "./models.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-models-"));
  dirs.push(dir);
  return dir;
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** `toCodexCredential` reads the expiry out of the access token's JWT `exp`. */
function fakeJwt(expiresAtSeconds: number): string {
  return `${base64url({ alg: "none", typ: "JWT" })}.${base64url({ exp: expiresAtSeconds })}.signature`;
}

/** A `CODEX_HOME` that `describeSubscriptionAuth` reports as logged in. */
async function loggedInCodexHome(models?: unknown[], clientVersion = "9.9.9"): Promise<string> {
  const dir = await tempDir();
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600),
        refresh_token: "refresh",
        account_id: "acct_1",
      },
    }),
  );
  if (models != null) {
    await writeFile(
      join(dir, "models_cache.json"),
      JSON.stringify({ fetched_at: "2026-09-17T19:03:38Z", client_version: clientVersion, models }),
    );
  }
  return dir;
}

const CACHED_MODELS = [
  { slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "最强", visibility: "list", priority: 1 },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 3 },
  { slug: "gpt-5.5-codex-mini", display_name: "Mini", visibility: "hide", priority: 2 },
];

const rejectRemote = () => Promise.reject(new Error("offline"));

describe("createModelCatalog", () => {
  it("falls back to the builtin list with a warning when Codex is not logged in", async () => {
    const catalog = createModelCatalog({ env: { CODEX_HOME: await tempDir() }, fetchCodexRemote: rejectRemote });

    const result = await catalog.list("codex");

    expect(result).toMatchObject({ engine: "codex", source: "builtin" });
    expect(result.models.map((entry) => entry.id)).toEqual(["gpt-5.5"]);
    expect(result.warning).toContain("Codex 未登录");
  });

  it("reads the Codex cache, drops hidden models and sorts by priority", async () => {
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await loggedInCodexHome(CACHED_MODELS) },
      fetchCodexRemote: rejectRemote,
    });

    const result = await catalog.list("codex");

    expect(result.source).toBe("codex-cache");
    expect(result.models).toEqual([
      { id: "gpt-6-astra", label: "GPT-6-Astra", description: "最强" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
    expect(result.warning).toContain("在线目录不可用");
  });

  it("prefers the remote catalog and passes the cache's client_version", async () => {
    const seen: string[] = [];
    const remote: CodexCatalogModel[] = [{ slug: "gpt-7", display_name: "GPT-7", priority: 1 }];
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await loggedInCodexHome(CACHED_MODELS, "1.2.3") },
      fetchCodexRemote: async ({ clientVersion }) => {
        seen.push(clientVersion);
        return remote;
      },
    });

    const result = await catalog.list("codex");

    expect(seen).toEqual(["1.2.3"]);
    expect(result.source).toBe("codex-remote");
    expect(result.warning).toBeUndefined();
    expect(result.models.map((entry) => entry.id)).toEqual(["gpt-7"]);
  });

  it("carries Codex's context_window through both engines, ignoring max_context_window", async () => {
    const withWindow = [
      { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1, context_window: 272_000, max_context_window: 872_000 },
      { slug: "gpt-old", display_name: "GPT-Old", visibility: "list", priority: 2 },
    ];
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await loggedInCodexHome(withWindow) },
      fetchCodexRemote: rejectRemote,
    });

    expect((await catalog.list("codex")).models).toEqual([
      { id: "gpt-6-astra", label: "GPT-6-Astra", contextWindow: 272_000 },
      { id: "gpt-old", label: "GPT-Old" },
    ]);
    // The `vgent` engine's prefixed mapping inherits the same window — and the
    // same name: it is the same model, and only the id carries the prefix.
    expect((await catalog.list("vgent")).models).toEqual([
      { id: "codex-subscription:gpt-6-astra", label: "GPT-6-Astra", contextWindow: 272_000 },
      { id: "codex-subscription:gpt-old", label: "GPT-Old" },
    ]);
  });

  it("merges the prefixed Codex models with the gateway's language models for vgent", async () => {
    const gateway: GatewayModelSource = {
      getAvailableModels: async () => ({
        models: [
          { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", modelType: "language" },
          { id: "openai/text-embedding-3", name: "Embedding", modelType: "embedding" },
        ],
      }),
    };
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await loggedInCodexHome(CACHED_MODELS), AI_GATEWAY_API_KEY: "k" },
      fetchCodexRemote: rejectRemote,
      gateway,
    });

    const result = await catalog.list("vgent");

    expect(result.source).toBe("codex-cache+gateway");
    expect(result.models.map((entry) => entry.id)).toEqual([
      "codex-subscription:gpt-6-astra",
      "codex-subscription:gpt-5.5",
      "anthropic/claude-sonnet-5",
    ]);
  });

  it("skips the gateway when no gateway credential is in the environment", async () => {
    let called = false;
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await tempDir() },
      fetchCodexRemote: rejectRemote,
      gateway: {
        getAvailableModels: async () => {
          called = true;
          return { models: [] };
        },
      },
    });

    const result = await catalog.list("vgent");

    expect(called).toBe(false);
    expect(result).toMatchObject({ source: "builtin" });
    expect(result.models.map((entry) => entry.id)).toEqual(["codex-subscription:gpt-5.5"]);
  });

  it("serves the builtin Claude Code aliases without an API key", async () => {
    const catalog = createModelCatalog({ env: {}, fetchCodexRemote: rejectRemote });

    const result = await catalog.list("claude-code");

    expect(result).toMatchObject({ engine: "claude-code", source: "builtin" });
    expect(result.warning).toBeUndefined();
    expect(result.models.map((entry) => entry.id)).toEqual(["sonnet", "opus", "haiku"]);
  });

  /**
   * The levels are never invented: Codex's own rows carry them, the
   * `codex-subscription:` entries are the same models so they inherit them,
   * Claude Code's three are its harness `thinking` setting, and on the gateway
   * only `openai/*` has a documented reasoning effort.
   */
  it("surfaces the reasoning levels each catalog row declares", async () => {
    const withLevels = [
      {
        slug: "gpt-6-astra",
        display_name: "GPT-6-Astra",
        visibility: "list",
        priority: 1,
        // The shape the real backend and `~/.codex/models_cache.json` use.
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth" },
          { effort: "high", description: "Greater reasoning depth" },
          { effort: "xhigh", description: "Extra high reasoning depth" },
        ],
        default_reasoning_level: "medium",
      },
      // No levels declared, so the entry gets none rather than a guess.
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 2 },
    ];
    const gateway: GatewayModelSource = {
      getAvailableModels: async () => ({
        models: [
          { id: "openai/gpt-5.5", name: "GPT-5.5" },
          { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        ],
      }),
    };
    const env = { CODEX_HOME: await loggedInCodexHome(withLevels), AI_GATEWAY_API_KEY: "k" };
    const catalog = createModelCatalog({ env, fetchCodexRemote: rejectRemote, gateway });

    const codex = await catalog.list("codex");
    expect(codex.models[0]).toMatchObject({
      id: "gpt-6-astra",
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoningLevel: "medium",
    });
    expect(codex.models[1]?.reasoningLevels).toBeUndefined();

    const vgent = await catalog.list("vgent");
    expect(vgent.models.find((entry) => entry.id === "codex-subscription:gpt-6-astra")).toMatchObject({
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      defaultReasoningLevel: "medium",
    });
    expect(vgent.models.find((entry) => entry.id === "openai/gpt-5.5")).toMatchObject({
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "medium",
    });
    expect(vgent.models.find((entry) => entry.id === "anthropic/claude-sonnet-5")?.reasoningLevels).toBeUndefined();

    const claudeCode = await createModelCatalog({ env: {}, fetchCodexRemote: rejectRemote }).list("claude-code");
    for (const entry of claudeCode.models) {
      expect(entry).toMatchObject({
        reasoningLevels: ["disabled", "adaptive", "enabled"],
        defaultReasoningLevel: "adaptive",
      });
    }
  });

  it("drops a default reasoning level the row does not itself support", async () => {
    const catalog = createModelCatalog({
      env: {
        CODEX_HOME: await loggedInCodexHome([
          {
            slug: "gpt-6-astra",
            visibility: "list",
            supported_reasoning_levels: ["low", "high"],
            default_reasoning_level: "medium",
          },
        ]),
      },
      fetchCodexRemote: rejectRemote,
    });

    const result = await catalog.list("codex");

    expect(result.models[0]?.reasoningLevels).toEqual(["low", "high"]);
    expect(result.models[0]?.defaultReasoningLevel).toBeUndefined();
  });

  it("caches per engine for ten minutes, and `refresh` bypasses the cache", async () => {
    let clock = 1_000_000;
    let calls = 0;
    const catalog = createModelCatalog({
      env: { CODEX_HOME: await loggedInCodexHome(CACHED_MODELS) },
      now: () => clock,
      fetchCodexRemote: async () => {
        calls += 1;
        return [{ slug: `gpt-${calls}`, priority: 1 }];
      },
    });

    expect((await catalog.list("codex")).models[0]?.id).toBe("gpt-1");
    expect((await catalog.list("codex")).models[0]?.id).toBe("gpt-1");
    expect(calls).toBe(1);

    expect((await catalog.list("codex", { refresh: true })).models[0]?.id).toBe("gpt-2");

    clock += 10 * 60_000;
    expect((await catalog.list("codex")).models[0]?.id).toBe("gpt-3");
    expect(calls).toBe(3);
  });
});

describe("Claude Code's full model ids", () => {
  const rejectCodex = async (): Promise<never> => {
    throw new Error("offline");
  };

  it("lists the provider catalog's Anthropic models after the aliases, without the catalog's context window", async () => {
    const catalog = createModelCatalog({
      env: {},
      fetchCodexRemote: rejectCodex,
      anthropicModels: async () => [{ id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000 } as { id: string; label?: string }, { id: "claude-haiku-4-5" }],
    });
    const result = await catalog.list("claude-code");
    expect(result.source).toBe("builtin+models.dev");
    expect(result.models.map((entry) => [entry.id, entry.label])).toEqual([
      ["sonnet", "sonnet"],
      ["opus", "opus"],
      ["haiku", "haiku"],
      ["claude-opus-5", "Claude Opus 5"],
      ["claude-haiku-4-5", "claude-haiku-4-5"],
    ]);
    // What the API can do is not what Claude Code runs with; the ring must not measure against it.
    expect(result.models.every((entry) => entry.contextWindow === undefined)).toBe(true);
    expect(result.models.every((entry) => entry.reasoningLevels?.length === 3)).toBe(true);
  });

  it("falls back to the aliases alone when the catalog cannot be read", async () => {
    const catalog = createModelCatalog({
      env: {},
      fetchCodexRemote: rejectCodex,
      anthropicModels: async () => {
        throw new Error("no catalog");
      },
    });
    const result = await catalog.list("claude-code");
    expect(result).toMatchObject({ source: "builtin" });
    expect(result.models.map((entry) => entry.id)).toEqual(["sonnet", "opus", "haiku"]);
  });
});
