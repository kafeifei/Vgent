import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexSpeedCatalog } from "./codex-catalog.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });
async function home() { const path = await mkdtemp(join(tmpdir(), "vgent-catalog-test-")); directories.push(path); return path; }
const model = { slug: "model", service_tiers: [{ id: "ultrafast", name: "Ultrafast" }], additional_speed_tiers: ["ultrafast"], base_instructions: "Runtime instructions", unknown_future_field: { keep: true } };

describe("native Codex speed catalog", () => {
  it("keeps the full remote metadata in isolated snapshots without altering the user's cache", async () => {
    const path = await home();
    const cache = JSON.stringify({ client_version: "9.9.9", models: [{ slug: "old" }] });
    await writeFile(join(path, "models_cache.json"), cache);
    const options = { env: { CODEX_HOME: path }, fetchCatalog: async () => [model] };
    const first = await prepareCodexSpeedCatalog(path, "model", "ultrafast", options);
    const second = await prepareCodexSpeedCatalog(path, "model", "ultrafast", options);
    expect(first.path).not.toBe(second.path);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({ models: [model] });
    expect(await readFile(join(path, "models_cache.json"), "utf8")).toBe(cache);
    await first.dispose();
    await expect(readFile(first.path)).rejects.toThrow();
    expect(JSON.parse(await readFile(second.path, "utf8"))).toEqual({ models: [model] });
    await second.dispose();
  });
  it("uses the cache offline, but rejects a tier withdrawn by a successful remote response", async () => {
    const path = await home();
    await writeFile(join(path, "models_cache.json"), JSON.stringify({ models: [model] }));
    const snapshot = await prepareCodexSpeedCatalog(path, "model", "ultrafast", { env: { CODEX_HOME: path }, fetchCatalog: async () => { throw new Error("offline"); } });
    expect(JSON.parse(await readFile(snapshot.path, "utf8"))).toEqual({ models: [model] });
    await snapshot.dispose();
    await expect(prepareCodexSpeedCatalog(path, "model", "ultrafast", { env: { CODEX_HOME: path }, fetchCatalog: async () => [{ slug: "model", service_tiers: [] }] })).rejects.toThrow("请刷新模型列表或选择标准速度");
  });
});
