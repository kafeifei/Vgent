import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createDraftStore, MAX_DRAFT_BYTES, NEW_TASK_DRAFT, type Draft } from "./store/drafts.js";
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

const readDraft = async (app: VgentApp, key: string): Promise<Draft> => (await (await request(app, `/api/drafts/${key}`)).json()) as Draft;
const draftOf = async (app: VgentApp, key: string): Promise<string> => (await readDraft(app, key)).text;

const PNG = { id: "a1", name: "截图.png", mediaType: "image/png", size: 3, url: "data:image/png;base64,AAEC" };
const NOTE = { id: "b2", name: "说明.txt", mediaType: "text/plain", size: 6, url: "data:text/plain;base64,5L2g5aW9" };

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("草稿 store", () => {
  it("keeps a draft per key and treats a blank as a delete", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);

    expect((await store.get("t1")).text).toBe("");
    await store.put("t1", "半句话");
    await store.put(NEW_TASK_DRAFT, "还没建任务");
    expect((await store.get("t1")).text).toBe("半句话");

    // A second store on the same directory reads the file, not the memory.
    expect((await createDraftStore(dir).get(NEW_TASK_DRAFT)).text).toBe("还没建任务");

    await store.put("t1", "");
    expect((await store.get("t1")).text).toBe("");
    const file = JSON.parse(await readFile(join(dir, "drafts.json"), "utf8")) as { drafts: Record<string, unknown> };
    expect(file.drafts).toEqual({ [NEW_TASK_DRAFT]: { text: "还没建任务", attachments: [] } });
  });

  it("writes an attachment's bytes once, under its id, and hands them back as a data URL", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);

    await store.put("t1", "看这张", [PNG]);
    expect(await exists(join(dir, "drafts", "t1", "a1"))).toBe(true);
    // The JSON names the file; it does not carry the bytes.
    const file = JSON.parse(await readFile(join(dir, "drafts.json"), "utf8")) as { drafts: Record<string, { attachments: unknown[] }> };
    expect(file.drafts.t1?.attachments).toEqual([{ id: "a1", name: "截图.png", mediaType: "image/png", size: 3 }]);

    // The next keystroke names the attachment by id alone, and the bytes stay.
    await store.put("t1", "看这张图", [{ id: "a1", name: "截图.png", mediaType: "image/png", size: 3 }]);
    expect(await createDraftStore(dir).get("t1")).toEqual({ text: "看这张图", attachments: [PNG] });
  });

  it("refuses an id it has never seen when the bytes are not sent with it", async () => {
    const store = createDraftStore(await tempDir());
    await expect(store.put("t1", "x", [{ id: "nope", name: "a", mediaType: "image/png", size: 1 }])).rejects.toThrow(/nope/);
  });

  it("deletes the file of a tile the user removed, and the directory with the last one", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);
    await store.put("t1", "", [PNG, NOTE]);

    await store.put("t1", "", [NOTE]);
    expect(await exists(join(dir, "drafts", "t1", "a1"))).toBe(false);
    expect((await store.get("t1")).attachments.map((entry) => entry.id)).toEqual(["b2"]);

    // Sent: no text, no files — the entry and its directory are gone.
    await store.put("t1", "", []);
    expect(await store.get("t1")).toEqual({ text: "", attachments: [] });
    expect(await exists(join(dir, "drafts", "t1"))).toBe(false);
  });

  it("reads the old text-only file and leaves out an attachment whose file went missing", async () => {
    const dir = await tempDir();
    await writeJsonAtomic(join(dir, "drafts.json"), { version: 1, drafts: { t1: "老格式的草稿", t2: "" } });
    const store = createDraftStore(dir);
    expect(await store.get("t1")).toEqual({ text: "老格式的草稿", attachments: [] });
    expect(await store.get("t2")).toEqual({ text: "", attachments: [] });

    await store.put("t1", "老格式的草稿", [PNG]);
    await rm(join(dir, "drafts", "t1", "a1"));
    expect(await createDraftStore(dir).get("t1")).toEqual({ text: "老格式的草稿", attachments: [] });
  });

  it("drops a corrupt file rather than failing every read", async () => {
    const dir = await tempDir();
    await writeJsonAtomic(join(dir, "drafts.json"), { nope: true });
    const store = createDraftStore(dir);
    expect((await store.get("t1")).text).toBe("");
    await store.put("t1", "重新开始");
    expect((await createDraftStore(dir).get("t1")).text).toBe("重新开始");
  });

  it("removes one key, its files included, and leaves the others", async () => {
    const dir = await tempDir();
    const store = createDraftStore(dir);
    await store.put("t1", "a", [PNG]);
    await store.put("t2", "b");
    await store.remove("t1");
    expect(await store.get("t1")).toEqual({ text: "", attachments: [] });
    expect(await exists(join(dir, "drafts", "t1"))).toBe(false);
    expect(await store.get("t2")).toEqual({ text: "b", attachments: [] });
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

  it("keeps the attachments with the text and only needs their bytes once", async () => {
    const dir = await tempDir();
    const first = makeApp(dir);

    const saved = (await (await putJson(first, "/api/drafts/new", { text: "带图", attachments: [PNG] })).json()) as Draft;
    expect(saved).toEqual({ text: "带图", attachments: [{ id: "a1", name: "截图.png", mediaType: "image/png", size: 3 }] });
    // A later keystroke: the id alone.
    const { url: _url, ...meta } = PNG;
    expect((await putJson(first, "/api/drafts/new", { text: "带图的", attachments: [meta] })).status).toBe(200);
    await first.shutdown();

    expect(await readDraft(makeApp(dir), "new")).toEqual({ text: "带图的", attachments: [PNG] });
  });

  it("refuses a bad key, a non-string, an absurd draft and a malformed attachment", async () => {
    const app = makeApp(await tempDir());
    expect((await request(app, "/api/drafts/not%2Fa%2Fkey")).status).toBe(400);
    expect((await putJson(app, "/api/drafts/new", { text: 42 })).status).toBe(400);
    const tooBig = "字".repeat(MAX_DRAFT_BYTES); // 3 bytes each in UTF-8
    expect((await putJson(app, "/api/drafts/new", { text: tooBig })).status).toBe(413);

    expect((await putJson(app, "/api/drafts/new", { text: "", attachments: "png" })).status).toBe(400);
    expect((await putJson(app, "/api/drafts/new", { text: "", attachments: [{ ...PNG, mediaType: "image/png; charset=x" }] })).status).toBe(400);
    expect((await putJson(app, "/api/drafts/new", { text: "", attachments: [{ ...PNG, id: "../x" }] })).status).toBe(400);
    expect((await putJson(app, "/api/drafts/new", { text: "", attachments: [{ ...PNG, url: "https://x/y.png" }] })).status).toBe(400);
    // Named by id only, and never uploaded.
    const { url: _url, ...meta } = PNG;
    const unknown = await putJson(app, "/api/drafts/new", { text: "", attachments: [meta] });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_draft_attachment");
    const huge = { ...PNG, url: `data:image/png;base64,${"A".repeat(15 * 1024 * 1024)}` };
    expect((await putJson(app, "/api/drafts/new", { text: "", attachments: [huge] })).status).toBe(413);
  });

  it("deletes a task's draft, files included, with the task", async () => {
    const dir = await tempDir();
    const app = makeApp(dir);
    const repo = await tempDir();
    const project = (await (await postJson(app, "/api/projects", { repoPath: repo })).json()) as Project;
    const thread = (await (await postJson(app, "/api/threads", { projectId: project.id, title: "草稿" })).json()) as ThreadRecord;

    await putJson(app, `/api/drafts/${thread.id}`, { text: "还没发出去", attachments: [PNG] });
    expect(await readDraft(app, thread.id)).toEqual({ text: "还没发出去", attachments: [PNG] });

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await readDraft(app, thread.id)).toEqual({ text: "", attachments: [] });
    expect(await exists(join(dir, "drafts", thread.id))).toBe(false);
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
