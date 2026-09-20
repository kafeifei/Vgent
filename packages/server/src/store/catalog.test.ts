import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "./catalog.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-catalog-"));
  dirs.push(dir);
  return dir;
}

const MODELS_DEV = {
  acme: {
    id: "acme",
    name: "Acme",
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.acme.test/v1",
    models: { "acme-1": { id: "acme-1", tool_call: true, modalities: { output: ["text"] } } },
  },
};

const online = (async () => new Response(JSON.stringify(MODELS_DEV), { status: 200 })) as typeof fetch;
const offline = (async () => {
  throw new Error("getaddrinfo ENOTFOUND models.dev");
}) as typeof fetch;

const cached = (version: number) => ({
  version,
  fetchedAt: "2026-01-01T00:00:00.000Z",
  providers: [{ id: "from-cache", name: "From cache", npm: "x", agents: {}, models: [] }],
});

describe("createCatalogStore", () => {
  it("fetches models.dev and keeps a copy on disk", async () => {
    const dir = await dataDir();
    const snapshot = await createCatalogStore(dir, { fetch: online }).get();
    expect(snapshot.source).toBe("live");
    expect(snapshot.providers.map((entry) => entry.id)).toContain("acme");
    expect(JSON.parse(await readFile(join(dir, "cache", "provider-catalog.json"), "utf8")).providers).toHaveLength(snapshot.providers.length);
  });

  it("serves the last copy, however old, when models.dev cannot be reached", async () => {
    const dir = await dataDir();
    await mkdir(join(dir, "cache"), { recursive: true });
    await writeFile(join(dir, "cache", "provider-catalog.json"), JSON.stringify(cached(2)));
    const store = createCatalogStore(dir, { fetch: offline });
    expect((await store.get()).providers.map((entry) => entry.id)).toEqual(["from-cache"]);
    // Asking for a refresh that fails changes nothing.
    expect((await store.refresh()).providers.map((entry) => entry.id)).toEqual(["from-cache"]);
  });

  it("still serves a copy written by an older build, and treats it as due for a refresh", async () => {
    const dir = await dataDir();
    await mkdir(join(dir, "cache"), { recursive: true });
    await writeFile(join(dir, "cache", "provider-catalog.json"), JSON.stringify(cached(1)));

    const stuck = await createCatalogStore(dir, { fetch: offline }).get();
    expect(stuck).toMatchObject({ source: "cache" });
    expect(stuck.fetchedAt).toBeUndefined();

    // Reachable again: the old copy answers this call, the fetch it set off replaces it.
    const store = createCatalogStore(dir, { fetch: online });
    expect((await store.get()).source).toBe("cache");
    expect((await store.refresh()).providers.map((entry) => entry.id)).toContain("acme");
  });

  it("falls back to the presets built into the app only when there has never been a copy", async () => {
    const snapshot = await createCatalogStore(await dataDir(), { fetch: offline }).get();
    expect(snapshot.source).toBe("builtin");
    expect(snapshot.providers.length).toBeGreaterThan(0);
  });
});
