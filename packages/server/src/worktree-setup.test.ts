import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";
import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import { createEngineRegistry, type EngineFactory } from "./engines/registry.js";
import type { ThreadRecord } from "./types.js";
import { findSetupSpec } from "./worktree-setup.js";

const execFileAsync = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-setup-"));
  dirs.push(dir);
  return dir;
}

/** A repo with one commit, optionally carrying a worktree setup config. */
async function gitRepo(config?: { path: string; body: unknown }): Promise<string> {
  const repo = await tempDir();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@vgent.local"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Vgent Test"], { cwd: repo });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line1\n");
  if (config != null) await writeConfig(repo, config.path, config.body);
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "初始"], { cwd: repo });
  return repo;
}

async function writeConfig(repo: string, relative: string, body: unknown): Promise<void> {
  const path = join(repo, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(body));
}

/**
 * A one-word engine that reports what it saw in the worktree the moment its
 * turn started — that is how 「先跑完 setup 再开跑」 is asserted.
 */
function markerEngine(marker: string) {
  const seen: boolean[] = [];
  const factory: EngineFactory = {
    async create(ctx) {
      return {
        async stream() {
          seen.push(ctx.thread.workspace != null && existsSync(join(ctx.thread.workspace.path, marker)));
          const parts = (async function* (): AsyncGenerator<TextStreamPart<ToolSet>> {
            yield { type: "start" };
            yield { type: "text-start", id: "t1" };
            yield { type: "text-delta", id: "t1", text: "好" };
            yield { type: "text-end", id: "t1" };
          })();
          return { stream: ReadableStream.from(parts) as ReadableStream<TextStreamPart<ToolSet>> };
        },
        hasUnfinishedTurn: () => false,
        async destroy() {},
        async finish() {},
      };
    },
  };
  return { factory, seen };
}

function makeApp(dataDir: string, factory?: EngineFactory): VgentApp {
  const instance = createApp({
    dataDir,
    token: TOKEN,
    ...(factory != null ? { registry: createEngineRegistry({ "claude-code": factory }) } : {}),
  });
  apps.push(instance);
  return instance;
}

const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

const request = (app: VgentApp, path: string, init?: RequestInit): Promise<Response> =>
  app.app.request(`${ORIGIN}${path}`, { ...init, headers: { ...auth, ...(init?.headers as Record<string, string>) } });

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });

const getThread = (app: VgentApp, id: string) => request(app, `/api/threads/${id}`).then((response) => response.json() as Promise<ThreadRecord>);

/** Polls the record until its setup is over. */
async function settledThread(app: VgentApp, id: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const thread = await getThread(app, id);
    const status = thread.workspace?.setup?.status;
    if (status === "ok" || status === "failed") return thread;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("setup 一直没有结束");
}

async function worktreeThread(app: VgentApp, repo: string): Promise<ThreadRecord> {
  const project = (await postJson(app, "/api/projects", { repoPath: repo }).then((r) => r.json())) as { id: string };
  const response = await postJson(app, "/api/threads", { projectId: project.id, workspace: "worktree" });
  expect(response.status).toBe(200);
  return (await response.json()) as ThreadRecord;
}

describe("findSetupSpec", () => {
  it("prefers .vgent over .cursor, and the platform key over the generic one", async () => {
    const repo = await tempDir();
    await writeConfig(repo, ".cursor/worktrees.json", { "setup-worktree": ["cursor"] });
    await writeConfig(repo, ".vgent/worktrees.json", { "setup-worktree": ["generic"], "setup-worktree-unix": ["unix"] });

    await expect(findSetupSpec(repo, "darwin")).resolves.toMatchObject({ kind: "commands", key: "setup-worktree-unix", commands: ["unix"] });
    await expect(findSetupSpec(repo, "linux")).resolves.toMatchObject({ key: "setup-worktree-unix" });
    // Windows has its own key; without one it falls back to the generic list.
    await expect(findSetupSpec(repo, "win32")).resolves.toMatchObject({ key: "setup-worktree", commands: ["generic"] });
  });

  it("falls through to .cursor when the .vgent config names no setup key", async () => {
    const repo = await tempDir();
    await writeConfig(repo, ".vgent/worktrees.json", { "something-else": true });
    await writeConfig(repo, ".cursor/worktrees.json", { "setup-worktree": ["cursor"] });
    await expect(findSetupSpec(repo, "darwin")).resolves.toMatchObject({ commands: ["cursor"] });
  });

  it("reads a script path relative to the config file, and reports nothing without a config", async () => {
    const repo = await tempDir();
    await writeConfig(repo, ".vgent/worktrees.json", { "setup-worktree": "setup.sh" });
    await expect(findSetupSpec(repo, "darwin")).resolves.toMatchObject({ kind: "script", scriptPath: join(repo, ".vgent", "setup.sh") });

    const bare = await tempDir();
    await expect(findSetupSpec(bare, "darwin")).resolves.toBeUndefined();
  });
});

describe.skipIf(!hasGit)("worktree setup", () => {
  it("runs the project's commands in the worktree and logs them", async () => {
    const repo = await gitRepo({ path: ".vgent/worktrees.json", body: { "setup-worktree": ["echo 装好了 > marker", "echo 第二步"] } });
    const app = makeApp(await tempDir());
    const created = await worktreeThread(app, repo);

    const thread = await settledThread(app, created.id);
    expect(thread.workspace?.setup).toMatchObject({ status: "ok", exitCode: 0 });
    expect(existsSync(join(thread.workspace!.path, "marker"))).toBe(true);
    // The project's own checkout is untouched: `ROOT_WORKTREE_PATH` points at it.
    expect(existsSync(join(repo, "marker"))).toBe(false);

    const body = (await request(app, `/api/threads/${created.id}/workspace/setup-log`).then((r) => r.json())) as {
      status: string;
      exitCode?: number;
      log: string;
    };
    expect(body).toMatchObject({ status: "ok", exitCode: 0 });
    expect(body.log).toContain("$ echo 装好了 > marker");
    expect(body.log).toContain("第二步");
  });

  it("hands ROOT_WORKTREE_PATH to the setup commands", async () => {
    const repo = await gitRepo({ path: ".cursor/worktrees.json", body: { "setup-worktree-unix": ['echo "$ROOT_WORKTREE_PATH" > root.txt'] } });
    const app = makeApp(await tempDir());
    const created = await worktreeThread(app, repo);
    const thread = await settledThread(app, created.id);
    expect(thread.workspace?.setup?.status).toBe("ok");
    const body = (await request(app, `/api/threads/${created.id}/workspace/setup-log`).then((r) => r.json())) as { log: string };
    expect(body.log).toContain(".cursor/worktrees.json");
  });

  it("stops at the first failing command, keeps its exit code, and still lets the turn run", async () => {
    const repo = await gitRepo({ path: ".vgent/worktrees.json", body: { "setup-worktree": ["exit 3", "echo 不该执行 > marker"] } });
    const engine = markerEngine("marker");
    const app = makeApp(await tempDir(), engine.factory);
    const created = await worktreeThread(app, repo);

    const thread = await settledThread(app, created.id);
    expect(thread.workspace?.setup).toMatchObject({ status: "failed", exitCode: 3 });
    expect(existsSync(join(thread.workspace!.path, "marker"))).toBe(false);

    const response = await postJson(app, `/api/chat/${created.id}`, {
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "开工" }] }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(engine.seen).toEqual([false]);
  });

  it("makes the first turn wait for a slow setup", async () => {
    const repo = await gitRepo({ path: ".vgent/worktrees.json", body: { "setup-worktree": ["sleep 0.3 && echo done > marker"] } });
    const engine = markerEngine("marker");
    const app = makeApp(await tempDir(), engine.factory);
    const created = await worktreeThread(app, repo);
    expect(existsSync(join(created.workspace!.path, "marker"))).toBe(false);

    // Sent immediately, as a user who typed while the install was still going.
    const response = await postJson(app, `/api/chat/${created.id}`, {
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "开工" }] }],
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(engine.seen).toEqual([true]);
    expect((await getThread(app, created.id)).workspace?.setup?.status).toBe("ok");
  });
});

describe.skipIf(!hasGit)("worktree 上限", () => {
  it("reclaims the oldest idle worktree once the cap is exceeded", async () => {
    const repo = await gitRepo();
    const app = makeApp(await tempDir());
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ worktreeMaxCount: 1 }) });

    const first = await worktreeThread(app, repo);
    const second = await worktreeThread(app, repo);

    for (let attempt = 0; attempt < 200 && (await getThread(app, first.id)).workspace?.reclaimed !== true; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const reclaimed = await getThread(app, first.id);
    expect(reclaimed.workspace).toMatchObject({ reclaimed: true });
    expect(reclaimed.workspace?.snapshotPath).toBeTypeOf("string");
    expect(existsSync(first.workspace!.path)).toBe(false);
    // The newest task keeps its files.
    expect((await getThread(app, second.id)).workspace?.reclaimed).toBeUndefined();
    expect(existsSync(second.workspace!.path)).toBe(true);
  });

  it("rejects a cap that is not a positive integer", async () => {
    const app = makeApp(await tempDir());
    const response = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ worktreeMaxCount: 0 }) });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "invalid_worktree_max_count" } });
  });
});
