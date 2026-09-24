import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessState, ThreadRecord } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";
import { createProjectStore } from "./projects.js";
import { asMcpServers, createSettingsStore } from "./settings.js";
import { createThreadStore } from "./threads.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-store-"));
  dirs.push(dir);
  return dir;
}

const execFileAsync = promisify(execFile);

/** A repo with one commit and a local git identity, so `git worktree add` has something to check out. */
async function gitRepo(): Promise<string> {
  const repo = await tempDir();
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@vgent.local"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Vgent Test"], { cwd: repo });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await writeFile(join(repo, "tracked.txt"), "line1\n");
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-q", "-m", "初始"], { cwd: repo });
  return repo;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeJsonAtomic", () => {
  it("leaves no temp file behind", async () => {
    const dir = await tempDir();
    const path = join(dir, "value.json");
    await writeJsonAtomic(path, { a: 1 });
    await writeJsonAtomic(path, { a: 2 });
    expect(await readdir(dir)).toEqual(["value.json"]);
    expect(await readJsonOrQuarantine(path)).toEqual({ a: 2 });
  });

  it("honours the requested mode", async () => {
    const dir = await tempDir();
    const path = join(dir, "secret.json");
    await writeJsonAtomic(path, { token: "x" }, { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("readJsonOrQuarantine", () => {
  it("renames an unparsable file and returns undefined", async () => {
    const dir = await tempDir();
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    expect(await readJsonOrQuarantine(path)).toBeUndefined();
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^broken\.json\.corrupt-/);
  });

  it("returns undefined for a missing file without touching the directory", async () => {
    const dir = await tempDir();
    expect(await readJsonOrQuarantine(join(dir, "absent.json"))).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("createThreadStore", () => {
  const seed = (dir: string) => createThreadStore(dir);

  it("rebuilds the index by scanning thread files", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    const thread = await store.create({ projectId: "p1", title: "第一个", engine: "claude-code" });

    await rm(join(dir, "threads", "index.json"));
    const reopened = seed(dir);
    const listed = await reopened.list();
    expect(listed.map((entry) => entry.id)).toEqual([thread.id]);
    expect(listed[0]?.messageCount).toBe(0);
  });

  it("quarantines a corrupt thread file and still lists the healthy ones", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    const good = await store.create({ projectId: "p1", title: "好的", engine: "claude-code" });
    const bad = await store.create({ projectId: "p1", title: "坏的", engine: "claude-code" });

    await writeFile(join(dir, "threads", `${bad.id}.json`), "{{{");
    await rm(join(dir, "threads", "index.json"));

    const reopened = seed(dir);
    expect((await reopened.list()).map((entry) => entry.id)).toEqual([good.id]);
    const entries = await readdir(join(dir, "threads"));
    expect(entries.some((entry) => entry.startsWith(`${bad.id}.json.corrupt-`))).toBe(true);
  });

  it("serializes concurrent writes to one thread", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    const thread = await store.create({ projectId: "p1", engine: "claude-code" });

    await Promise.all(Array.from({ length: 8 }, (_, index) => store.update(thread.id, { title: `标题-${index}` })));

    const record = (await store.get(thread.id)) as ThreadRecord;
    // The chain preserves call order, so the last update is the one on disk.
    expect(record.title).toBe("标题-7");
    expect((await readdir(join(dir, "threads"))).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
  });

  it("keeps the last activity time for Git stats and read state, but advances it for a new message", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
      const thread = await store.create({ projectId: "p1", engine: "claude-code" });
      vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));

      const statted = await store.update(thread.id, { changeStats: { files: 1, additions: 2, deletions: 0 } });
      expect(statted.updatedAt).toBe(thread.updatedAt);
      expect((await store.list())[0]?.updatedAt).toBe(thread.updatedAt);

      const marked = await store.update(thread.id, { unread: true });
      expect(marked.updatedAt).toBe(thread.updatedAt);
      vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
      const read = await store.update(thread.id, { unread: false });
      expect(read.unread).toBeUndefined();
      expect(read.updatedAt).toBe(thread.updatedAt);
      expect((await store.list())[0]?.updatedAt).toBe(read.updatedAt);

      vi.setSystemTime(new Date("2026-09-20T12:00:00.000Z"));
      const replied = await store.update(thread.id, { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "继续" }] }] });
      expect(replied.updatedAt).toBe("2026-09-20T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the harness state file 0600 and reads it back", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    const thread = await store.create({ projectId: "p1", engine: "claude-code" });
    const state = {
      version: 1,
      sessionId: thread.id,
      resumeFrom: { harnessId: "fake", specificationVersion: 1, data: { cursor: 3 } },
      updatedAt: new Date().toISOString(),
    } as unknown as HarnessState;

    await store.saveHarnessState(thread.id, state);
    const path = join(dir, "threads", `${thread.id}.harness.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.loadHarnessState(thread.id)).toEqual(state);
  });

  it("keeps pre-compact snapshots out of the index, sweeps a thread's own on remove, and leaves other threads' alone", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    const doomed = await store.create({ projectId: "p1", title: "要压缩的", engine: "claude-code" });
    const other = await store.create({ projectId: "p1", title: "另一个", engine: "claude-code" });

    await store.snapshotBeforeCompact(doomed.id, [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
    await store.snapshotBeforeCompact(doomed.id, [{ id: "m2", role: "user", parts: [{ type: "text", text: "hi again" }] }]);
    await store.snapshotBeforeCompact(other.id, [{ id: "m3", role: "user", parts: [{ type: "text", text: "unrelated" }] }]);

    const threadsDir = join(dir, "threads");
    const doomedSnapshots = () => readdir(threadsDir).then((entries) => entries.filter((entry) => entry.startsWith(`${doomed.id}.pre-compact.`)));
    const otherSnapshots = () => readdir(threadsDir).then((entries) => entries.filter((entry) => entry.startsWith(`${other.id}.pre-compact.`)));
    expect(await doomedSnapshots()).toHaveLength(2);
    expect(await otherSnapshots()).toHaveLength(1);

    // A rebuild must not pick the snapshot sidecars up as thread records.
    await rm(join(threadsDir, "index.json"));
    const reopened = seed(dir);
    expect((await reopened.list()).map((entry) => entry.id).sort()).toEqual([doomed.id, other.id].sort());

    await store.remove(doomed.id);
    expect(await doomedSnapshots()).toHaveLength(0);
    expect(await otherSnapshots()).toHaveLength(1);
    expect((await store.list()).map((entry) => entry.id)).toEqual([other.id]);
  });

  it("notifies subscribers on every commit and drops the files on remove", async () => {
    const dir = await tempDir();
    const store = seed(dir);
    let events = 0;
    const unsubscribe = store.subscribe(() => {
      events += 1;
    });

    const thread = await store.create({ projectId: "p1", engine: "claude-code" });
    await store.update(thread.id, { status: "idle" });
    await store.saveHarnessState(thread.id, { version: 1, sessionId: thread.id, resumeFrom: {}, updatedAt: "now" } as unknown as HarnessState);
    await store.remove(thread.id);
    unsubscribe();

    expect(events).toBe(3);
    expect(await store.list()).toEqual([]);
    expect(await readdir(join(dir, "threads"))).toEqual(["index.json"]);
  });
});

describe("createProjectStore / createSettingsStore", () => {
  it("rejects a repo path that is not a directory and keeps projects across reopens", async () => {
    const dir = await tempDir();
    const store = createProjectStore(dir);
    await expect(store.create({ repoPath: join(dir, "nope") })).rejects.toMatchObject({ status: 400 });

    const project = await store.create({ repoPath: dir });
    expect(project.name).toBe(dir.split("/").at(-1));
    expect((await createProjectStore(dir).list()).map((entry) => entry.id)).toEqual([project.id]);
  });

  it("registers a plain non-git folder as itself, without a note", async () => {
    const dataDir = await tempDir();
    const plain = await tempDir();
    const store = createProjectStore(dataDir);
    const project = await store.create({ repoPath: plain });
    expect(project.repoPath).toBe(await realpath(plain));
    expect(project).not.toHaveProperty("note");
  });

  it("redirects a linked git worktree to its main checkout, with a note, and dedups against it", async () => {
    const dataDir = await tempDir();
    const repo = await gitRepo();
    const worktreesParent = await tempDir();
    const worktreePath = join(worktreesParent, "linked");
    await execFileAsync("git", ["worktree", "add", "-b", "feature", worktreePath], { cwd: repo });

    const store = createProjectStore(dataDir);
    const project = await store.create({ repoPath: worktreePath });
    expect(project.repoPath).toBe(await realpath(repo));
    expect(project.name).toBe(basename(await realpath(repo)));
    expect(project.note).toMatch(/git worktree.*已归到主仓库/);

    // Registering the main repo directly must land on the very same project.
    const again = await store.create({ repoPath: repo });
    expect(again.id).toBe(project.id);
    expect(again).not.toHaveProperty("note");
    expect(await store.list()).toHaveLength(1);
  });

  it("folds a pre-existing worktree entry into its already-registered main checkout on load", async () => {
    const dataDir = await tempDir();
    const repo = await gitRepo();
    const worktreesParent = await tempDir();
    const worktreePath = join(worktreesParent, "linked");
    await execFileAsync("git", ["worktree", "add", "-b", "feature", worktreePath], { cwd: repo });

    const mainProject = { id: "main-id", name: basename(repo), repoPath: await realpath(repo), createdAt: new Date().toISOString() };
    const worktreeProject = { id: "worktree-id", name: "linked", repoPath: worktreePath, createdAt: new Date().toISOString() };
    await writeJsonAtomic(join(dataDir, "projects.json"), { version: 1, projects: [mainProject, worktreeProject] });

    const store = createProjectStore(dataDir);
    expect((await store.list()).map((project) => project.id)).toEqual(["main-id"]);

    const onDisk = await readJsonOrQuarantine<{ projects: { id: string }[] }>(join(dataDir, "projects.json"));
    expect(onDisk?.projects.map((project) => project.id)).toEqual(["main-id"]);
  });

  it("retargets a lone pre-existing worktree entry to its main checkout on load", async () => {
    const dataDir = await tempDir();
    const repo = await gitRepo();
    const worktreesParent = await tempDir();
    const worktreePath = join(worktreesParent, "linked");
    await execFileAsync("git", ["worktree", "add", "-b", "feature", worktreePath], { cwd: repo });

    const worktreeProject = { id: "worktree-id", name: "linked", repoPath: worktreePath, createdAt: new Date().toISOString() };
    await writeJsonAtomic(join(dataDir, "projects.json"), { version: 1, projects: [worktreeProject] });

    const store = createProjectStore(dataDir);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("worktree-id");
    expect(listed[0]?.repoPath).toBe(await realpath(repo));
    expect(listed[0]?.name).toBe(basename(await realpath(repo)));
  });

  it("round-trips settings and clears an optional field", async () => {
    const dir = await tempDir();
    const store = createSettingsStore(dir);
    expect((await store.get()).defaultEngine).toBe("vgent");
    await store.update({ defaultModel: "sonnet", runMode: "allow-edits" });
    expect(await createSettingsStore(dir).get()).toMatchObject({ defaultModel: "sonnet", runMode: "allow-edits" });
    expect(await store.update({ defaultModel: undefined })).not.toHaveProperty("defaultModel");
  });

  it("promotes an older file's defaultPermissionMode to the global run mode", async () => {
    const dir = await tempDir();
    await writeJsonAtomic(join(dir, "settings.json"), { defaultEngine: "vgent", defaultPermissionMode: "allow-all" });

    const migrated = await createSettingsStore(dir).get();
    expect(migrated).toMatchObject({ defaultEngine: "vgent", runMode: "allow-all", allowlist: [] });
    expect(migrated).not.toHaveProperty("defaultPermissionMode");

    // A file with neither field falls back to the default, 自动改文件.
    const bare = await tempDir();
    await writeJsonAtomic(join(bare, "settings.json"), { defaultEngine: "codex" });
    expect(await createSettingsStore(bare).get()).toMatchObject({ runMode: "allow-reads", allowlist: [] });
  });

  it("folds the older engine-per-model map into the remembered picks", async () => {
    const dir = await tempDir();
    await writeJsonAtomic(join(dir, "settings.json"), {
      defaultEngine: "vgent",
      modelEngines: { "codex/gpt-5.5": "vgent", "gateway/kimi": "vgent" },
      modelPicks: { "codex/gpt-5.5": { reasoningEffort: "xhigh", serviceTier: 7 }, junk: "fast" },
    });

    const migrated = await createSettingsStore(dir).get();
    expect(migrated.modelPicks).toEqual({
      "codex/gpt-5.5": { engine: "vgent", reasoningEffort: "xhigh" },
      "gateway/kimi": { engine: "vgent" },
    });
    expect(migrated).not.toHaveProperty("modelEngines");
  });

  it("dedupes the global allowlist", async () => {
    const dir = await tempDir();
    const store = createSettingsStore(dir);
    expect((await store.update({ allowlist: ["bash", "write", "bash"] })).allowlist).toEqual(["bash", "write"]);
    expect((await createSettingsStore(dir).get()).allowlist).toEqual(["bash", "write"]);
    expect((await store.update({ allowlist: [] })).allowlist).toEqual([]);
  });

  it("stores a validated MCP server list and clears it when emptied", async () => {
    const dir = await tempDir();
    const store = createSettingsStore(dir);

    const servers = asMcpServers([{ name: "local", command: "node", args: ["server.js"] }]);
    await store.update({ mcpServers: servers });
    expect(await createSettingsStore(dir).get()).toMatchObject({ mcpServers: servers });

    expect(await store.update({ mcpServers: [] })).not.toHaveProperty("mcpServers");
  });

  it("rejects a malformed MCP server list rather than dropping it", () => {
    expect(asMcpServers(undefined)).toBeUndefined();
    expect(asMcpServers(null)).toBeUndefined();
    expect(() => asMcpServers([{ name: "x" }])).toThrow(/command/);
    expect(() => asMcpServers("nope")).toThrow(/数组/);
  });
});
