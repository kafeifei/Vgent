import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createDraftStore, MAX_DRAFT_BYTES, NEW_TASK_DRAFT } from "./store/drafts.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
import type { Project, Settings, ThreadRecord } from "./types.js";

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-drafts-"));
  dirs.push(dir);
  return dir;
}

function makeApp(dataDir: string): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN });
  apps.push(instance);
  return instance;
}

const auth = { authorization: `Bearer ${TOKEN}` };

function request(app: VgentApp, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...auth, ...(init?.body != null ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
}

const putJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "PUT", body: JSON.stringify(body) });
const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });

const draftOf = async (app: VgentApp, key: string): Promise<string> =>
  ((await (await request(app, `/api/drafts/${key}`)).json()) as { text: string }).text;

describe("草稿 store", () => {
  it("keeps a draft per key and treats a blank as a delete", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);

    expect(await store.get("t1")).toBe("");
    await store.put("t1", "半句话");
    await store.put(NEW_TASK_DRAFT, "还没建任务");
    expect(await store.get("t1")).toBe("半句话");

    // A second store on the same directory reads the file, not the memory.
    expect(await createDraftStore(dir).get(NEW_TASK_DRAFT)).toBe("还没建任务");

    await store.put("t1", "");
    expect(await store.get("t1")).toBe("");
    const file = JSON.parse(await readFile(join(dir, "drafts.json"), "utf8")) as { drafts: Record<string, string> };
    expect(file.drafts).toEqual({ [NEW_TASK_DRAFT]: "还没建任务" });
  });

  it("drops a corrupt file rather than failing every read", async () => {
    const dir = await tempDir();
    await writeJsonAtomic(join(dir, "drafts.json"), { nope: true });
    const store = createDraftStore(dir);
    expect(await store.get("t1")).toBe("");
    await store.put("t1", "重新开始");
    expect(await createDraftStore(dir).get("t1")).toBe("重新开始");
  });

  it("removes one key and leaves the others", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);
    await store.put("t1", "a");
    await store.put("t2", "b");
    await store.remove("t1");
    expect(await store.get("t1")).toBe("");
    expect(await store.get("t2")).toBe("b");
  });
});

describe("草稿 routes", () => {
  it("round-trips a draft for a task and for the empty state, and survives a restart on another port", async () => {
    const dir = await tempDir();
    const first = makeApp(dir);

    expect(await draftOf(first, "new")).toBe("");
    expect((await putJson(first, "/api/drafts/new", { text: "先写一半" })).status).toBe(200);
    expect((await putJson(first, "/api/drafts/9f1c0d2e-0000-4000-8000-000000000001", { text: "任务里的草稿" })).status).toBe(200);
    await first.shutdown();

    // The port is not part of anything the server stores — a second process on
    // the same data dir sees the same drafts. That is the whole point of the move.
    const second = makeApp(dir);
    expect(await draftOf(second, "new")).toBe("先写一半");
    expect(await draftOf(second, "9f1c0d2e-0000-4000-8000-000000000001")).toBe("任务里的草稿");
  });

  it("deletes the entry when the text is blank", async () => {
    const app = makeApp(await tempDir());
    await putJson(app, "/api/drafts/new", { text: "写了点" });
    await putJson(app, "/api/drafts/new", { text: "" });
    expect(await draftOf(app, "new")).toBe("");
  });

  it("refuses a bad key, a non-string and an absurd draft", async () => {
    const app = makeApp(await tempDir());
    expect((await request(app, "/api/drafts/not%2Fa%2Fkey")).status).toBe(400);
    expect((await putJson(app, "/api/drafts/new", { text: 42 })).status).toBe(400);
    const tooBig = "字".repeat(MAX_DRAFT_BYTES); // 3 bytes each in UTF-8
    expect((await putJson(app, "/api/drafts/new", { text: tooBig })).status).toBe(413);
  });

  it("deletes a task's draft with the task", async () => {
    const app = makeApp(await tempDir());
    const repo = await tempDir();
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (await postJson(app, "/api/threads", { projectId: project.id, title: "草稿" })).json()) as ThreadRecord;

    await putJson(app, `/api/drafts/${thread.id}`, { text: "还没发出去" });
    expect(await draftOf(app, thread.id)).toBe("还没发出去");

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await draftOf(app, thread.id)).toBe("");
  });
});

describe("界面偏好", () => {
  it("stores theme and density in settings and hands them back after a restart", async () => {
    const dir = await tempDir();
    const first = makeApp(dir);

    const saved = (await (await putJson(first, "/api/settings", { theme: "light", density: "compact" })).json()) as Settings;
    expect(saved).toMatchObject({ theme: "light", density: "compact" });
    await first.shutdown();

    const second = makeApp(dir);
    const reread = (await (await request(second, "/api/settings")).json()) as Settings;
    expect(reread).toMatchObject({ theme: "light", density: "compact" });

    // `null` puts the built-in default back, which is what「深色 / 舒适」means.
    const cleared = (await (await putJson(second, "/api/settings", { theme: null, density: null })).json()) as Settings;
    expect(cleared).not.toHaveProperty("theme");
    expect(cleared).not.toHaveProperty("density");
  });

  it("refuses a theme or density it does not know", async () => {
    const app = makeApp(await tempDir());
    expect((await putJson(app, "/api/settings", { theme: "midnight" })).status).toBe(400);
    expect((await putJson(app, "/api/settings", { density: "roomy" })).status).toBe(400);
  });

  it("leaves the run mode alone when only the theme is sent", async () => {
    const app = makeApp(await tempDir());
    await putJson(app, "/api/settings", { runMode: "allow-edits" });
    const after = (await (await putJson(app, "/api/settings", { theme: "light" })).json()) as Settings;
    expect(after).toMatchObject({ runMode: "allow-edits", theme: "light" });
  });
});
