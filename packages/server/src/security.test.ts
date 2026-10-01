import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type CreateAppOptions, type VgentApp } from "./app.js";
import { NotFoundError } from "./errors.js";
import { REDACTED } from "./remote/policy.js";
import { createPlanStore } from "./store/plans.js";
import { createThreadStore, isThreadId } from "./store/threads.js";

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7412";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

/**
 * What every app here is built with: this machine's logins answered for (Claude
 * signed in, Codex not), no models.dev, and a Downloads folder of its own.
 */
const appOptions = (dataDir: string, extra?: Partial<CreateAppOptions>): CreateAppOptions => ({
  ...extra,
  dataDir,
  token: TOKEN,
  probeClaudeLogin: async () => ({ loggedIn: true, email: "dev@example.com" }),
  accountOptions: { probeCodex: async () => ({ codex: { available: false, source: null } }), ...extra?.accountOptions },
  catalogFetch: async () => {
    throw new Error("offline in tests");
  },
  downloadsDir: join(dataDir, "Downloads"),
});

async function setup(dataDir?: string, extra?: Partial<CreateAppOptions>): Promise<{ app: VgentApp; dataDir: string }> {
  if (dataDir == null) {
    dataDir = await mkdtemp(join(tmpdir(), "vgent-security-"));
    dirs.push(dataDir);
  }
  const app = createApp(appOptions(dataDir, extra));
  apps.push(app);
  return { app, dataDir };
}

const request = (app: VgentApp, path: string, init?: RequestInit) =>
  app.app.request(`${ORIGIN}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}` } });

/** The same request as the remote gateway forwards it. */
const asRemote = (app: VgentApp, path: string, init?: RequestInit) =>
  app.app.request(`${ORIGIN}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "x-vgent-remote": "1", "content-type": "application/json" } });

/** A state stream, read one event at a time. */
async function openState(app: Pick<VgentApp, "app">, headers: Record<string, string>) {
  const controller = new AbortController();
  const response = await app.app.request(`${ORIGIN}/api/state`, { headers: { authorization: `Bearer ${TOKEN}`, ...headers }, signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<string> => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith("event: state")) return block;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("状态流提前结束");
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return {
    next,
    /** The first event that says `text`. */
    async until(text: string): Promise<string> {
      for (;;) {
        const event = await next();
        if (event.includes(text)) return event;
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
      controller.abort();
    },
  };
}

/** The first state a stream sends. */
async function firstState(app: VgentApp, headers: Record<string, string>): Promise<string> {
  const stream = await openState(app, headers);
  try {
    return await stream.next();
  } finally {
    await stream.close();
  }
}

describe("thread ids name files, so only plain ids name threads", () => {
  it("recognises what a thread id may look like", () => {
    for (const id of ["a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab", "thread_1", "t1"]) expect(isThreadId(id), id).toBe(true);
    for (const id of ["", ".", "..", "../x", "x/../..", "a/b", "a\\b", ".hidden", "-x", "a b", "a\0b", "x".repeat(129)]) {
      expect(isThreadId(id), JSON.stringify(id)).toBe(false);
    }
  });

  it("does not let a DELETE climb out of the data directory through an encoded slash", async () => {
    const { app, dataDir } = await setup();
    // `attachments/<id>` with id `x/../../victim` is `<dataDir>/victim`.
    await mkdir(join(dataDir, "victim"), { recursive: true });
    await writeFile(join(dataDir, "victim", "keep.txt"), "still here");

    const response = await request(app, "/api/threads/x%2F..%2F..%2Fvictim", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(await readFile(join(dataDir, "victim", "keep.txt"), "utf8")).toBe("still here");
  });

  it("does not read, or quarantine, another data file as if it were a thread", async () => {
    const { app, dataDir } = await setup();
    await writeFile(join(dataDir, "providers.json"), "not a thread record");

    const response = await request(app, "/api/threads/..%2Fproviders");

    expect(response.status).toBe(404);
    // A record that fails to parse is renamed aside; this one must not be looked at.
    expect(await readFile(join(dataDir, "providers.json"), "utf8")).toBe("not a thread record");
  });

  it("guards the chat routes the same way", async () => {
    const { app } = await setup();
    expect((await request(app, "/api/chat/a%2Fb/stream")).status).toBe(404);
    expect((await request(app, "/api/chat/a%2Fb/stop", { method: "POST" })).status).toBe(404);
    expect((await request(app, "/api/threads/a%2Fb/plan")).status).toBe(404);
  });

  it("still answers a well-formed id that names no thread with the ordinary 404", async () => {
    const { app } = await setup();
    const response = await request(app, "/api/threads/a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("thread_not_found");
  });

  it("refuses a bad id at the stores too, whoever calls them", async () => {
    const { dataDir } = await setup();
    const threads = createThreadStore(dataDir);
    await expect(threads.get("../providers")).rejects.toBeInstanceOf(NotFoundError);
    await expect(threads.remove("x/../..")).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPlanStore(dataDir).remove("../x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("what a remote session is shown of the settings", () => {
  const servers = [{ name: "github", command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp_secret" } }];

  async function withServers(): Promise<VgentApp> {
    const { app } = await setup();
    // At the machine: no remote mark.
    const saved = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ mcpServers: servers }) });
    expect(saved.status).toBe(200);
    return app;
  }

  it("keeps the MCP servers' env out of a read of the settings, and leaves the machine's own read whole", async () => {
    const app = await withServers();

    const remote = await asRemote(app, "/api/settings");
    expect(remote.status).toBe(200);
    expect(await remote.json()).toMatchObject({ mcpServers: [{ name: "github", command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: REDACTED } }] });

    const local = await request(app, "/api/settings");
    expect(await local.json()).toMatchObject({ mcpServers: [{ env: { GITHUB_TOKEN: "ghp_secret" } }] });
  });

  it("does so in the answer to a write it is allowed too", async () => {
    const app = await withServers();
    const response = await asRemote(app, "/api/settings", { method: "PUT", body: JSON.stringify({ theme: "dark" }) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { theme: string; mcpServers: Array<{ env: Record<string, string> }> };
    expect(body.theme).toBe("dark");
    expect(body.mcpServers[0]?.env).toEqual({ GITHUB_TOKEN: REDACTED });
    // And what is stored is still the real thing.
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({ mcpServers: [{ env: { GITHUB_TOKEN: "ghp_secret" } }] });
  });

  it("never lets the redacted view be written back over the real one", async () => {
    const app = await withServers();
    const shown = (await (await asRemote(app, "/api/settings")).json()) as { mcpServers: unknown[] };
    for (const body of [{ mcpServers: shown.mcpServers }, { theme: "light", mcpServers: shown.mcpServers }, { ...shown }]) {
      const response = await asRemote(app, "/api/settings", { method: "PUT", body: JSON.stringify(body) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "remote_forbidden" } });
    }
    expect(await (await request(app, "/api/settings")).json()).toMatchObject({ mcpServers: [{ env: { GITHUB_TOKEN: "ghp_secret" } }] });
  });

  it("does so in the state stream, which carries the settings along", async () => {
    const app = await withServers();
    expect(await firstState(app, { "x-vgent-remote": "1" })).not.toContain("ghp_secret");
    expect(await firstState(app, {})).toContain("ghp_secret");
  });
});

describe("what a remote session leaves to the machine", () => {
  const forbidden = async (response: Response) => {
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "remote_forbidden" } });
  };

  it("lets it see which accounts there are, and not sign one in, out or switch what it is used for", async () => {
    const cli = { login: vi.fn(), logout: vi.fn(async () => {}) };
    const { app } = await setup(undefined, { accountOptions: { cli } });

    const listed = await asRemote(app, "/api/accounts");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { accounts: Array<{ id: string }> }).accounts.map((account) => account.id)).toContain("claude");

    for (const [method, path, body] of [
      ["POST", "/api/accounts/login", { kind: "claude" }],
      // The login under way, device code and all.
      ["GET", "/api/accounts/login", undefined],
      ["DELETE", "/api/accounts/login", undefined],
      ["DELETE", "/api/accounts/claude", undefined],
      ["PUT", "/api/accounts/claude/uses", { use: "claude-code", enabled: false }],
    ] as const) {
      await forbidden(await asRemote(app, path, { method, ...(body != null ? { body: JSON.stringify(body) } : {}) }));
    }
    expect(cli.login).not.toHaveBeenCalled();
    expect(cli.logout).not.toHaveBeenCalled();
    // At the machine the same routes answer as they always did.
    expect((await request(app, "/api/accounts/login")).status).toBe(200);
  });

  it("lets it see the engine options, and not change what the agents may reach", async () => {
    const { app } = await setup();
    const option = { engine: "opencode", key: "web", value: false };

    await forbidden(await asRemote(app, "/api/settings/engine-options", { method: "PUT", body: JSON.stringify(option) }));
    // Nor through the settings document itself.
    await forbidden(await asRemote(app, "/api/settings", { method: "PUT", body: JSON.stringify({ engineOptions: { opencode: { web: false } } }) }));
    expect(((await (await request(app, "/api/settings")).json()) as { engineOptions?: unknown }).engineOptions).toBeUndefined();

    const local = await request(app, "/api/settings/engine-options", { method: "PUT", body: JSON.stringify(option) });
    expect(local.status).toBe(200);
    expect(await (await asRemote(app, "/api/settings")).json()).toMatchObject({ engineOptions: { opencode: { web: false } } });
  });
});

describe("a hand-edited settings file", () => {
  /** The object-map shape other MCP clients write, with a field Vgent has no use for. */
  const handEdited = {
    defaultEngine: "vgent",
    runMode: "allow-reads",
    allowlist: [],
    mcpServers: {
      github: { command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp_map_secret" } },
      docs: { type: "sse", url: "https://docs.example.com/mcp?key=url-secret", headers: { Authorization: "Bearer header-secret" } },
      broken: { args: ["no command"] },
    },
  };

  async function withFile(): Promise<VgentApp> {
    const dataDir = await mkdtemp(join(tmpdir(), "vgent-security-"));
    dirs.push(dataDir);
    await writeFile(join(dataDir, "settings.json"), JSON.stringify(handEdited));
    return (await setup(dataDir)).app;
  }

  it("is read as the server list it means, without what no server is started with", async () => {
    const app = await withFile();
    const local = (await (await request(app, "/api/settings")).json()) as { mcpServers: unknown };
    expect(local.mcpServers).toEqual([
      { name: "github", command: "npx", args: ["-y", "server-github"], env: { GITHUB_TOKEN: "ghp_map_secret" } },
      { name: "docs", url: "https://docs.example.com/mcp?key=url-secret", transport: "sse" },
    ]);
    expect(JSON.stringify(local)).not.toContain("header-secret");
  });

  it("keeps its secrets from a remote read and from the remote state stream", async () => {
    const app = await withFile();
    const remote = await asRemote(app, "/api/settings");
    expect(remote.status).toBe(200);
    const text = await remote.text();
    expect(text).not.toMatch(/ghp_map_secret|url-secret|header-secret/);
    expect(JSON.parse(text)).toMatchObject({ mcpServers: [{ name: "github", env: { GITHUB_TOKEN: REDACTED } }, { name: "docs", url: "https://docs.example.com" }] });

    const first = await firstState(app, { "x-vgent-remote": "1" });
    expect(first).toContain("github");
    expect(first).not.toMatch(/ghp_map_secret|url-secret|header-secret/);
  });

  it("does not stop the machine's own state updates while a remote session watches", async () => {
    const app = await withFile();
    const remote = await openState(app, { "x-vgent-remote": "1" });
    const local = await openState(app, {});
    try {
      await Promise.all([remote.next(), local.next()]);
      await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ theme: "light" }) });
      expect(await local.until('"theme":"light"')).toContain("ghp_map_secret");
      expect(await remote.until('"theme":"light"')).not.toContain("ghp_map_secret");
    } finally {
      await Promise.all([remote.close(), local.close()]);
    }
  });
});

describe("the state stream, when one kind of client cannot be served", () => {
  afterEach(() => {
    vi.doUnmock("./remote/policy.js");
    vi.resetModules();
  });

  it("still serves the others, and never sends the remote one the machine's own copy instead", async () => {
    // The remote view builds for the first remote client, then breaks.
    vi.resetModules();
    vi.doMock("./remote/policy.js", async (importOriginal) => {
      const policy = await importOriginal<typeof import("./remote/policy.js")>();
      let built = 0;
      return {
        ...policy,
        redactSettingsForRemote: (settings: unknown) => {
          built += 1;
          if (built > 1) throw new Error("远程视图坏了");
          return policy.redactSettingsForRemote(settings);
        },
      };
    });
    const { createApp: createFreshApp } = await import("./app.js");
    const dataDir = await mkdtemp(join(tmpdir(), "vgent-security-"));
    dirs.push(dataDir);
    const app = createFreshApp(appOptions(dataDir));
    apps.push(app);
    await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ mcpServers: [{ name: "gh", command: "npx", env: { GITHUB_TOKEN: "ghp_local_only" } }] }) });

    const remote = await openState(app, { "x-vgent-remote": "1" });
    const local = await openState(app, {});
    try {
      await Promise.all([remote.next(), local.next()]);
      await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ theme: "light" }) });
      expect(await local.until('"theme":"light"')).toContain("ghp_local_only");
      // Nothing, rather than the unredacted copy: the next event, if any came, would be read here.
      const nothing = await Promise.race([remote.next(), new Promise<undefined>((done) => setTimeout(done, 300, undefined))]);
      expect(nothing).toBeUndefined();
    } finally {
      await Promise.all([remote.close(), local.close()]);
    }
  });
});

describe("what a remote session can open through a task", () => {
  const execFileAsync = promisify(execFile);

  /** A home directory that is a git repo, with the data dir inside it — the data dir holding secrets. */
  async function homeWithDataDir() {
    const home = await realpath(await mkdtemp(join(tmpdir(), "vgent-security-home-")));
    dirs.push(home);
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "test@vgent.local"], ["config", "user.name", "Vgent Test"], ["config", "commit.gpgsign", "false"]]) {
      await execFileAsync("git", args, { cwd: home });
    }
    await writeFile(join(home, "notes.md"), "mine\n");
    await execFileAsync("git", ["add", "-A"], { cwd: home });
    await execFileAsync("git", ["commit", "-q", "-m", "初始"], { cwd: home });
    const dataDir = join(home, ".vgent");
    const { app } = await setup(dataDir);
    const saved = await request(app, "/api/settings", { method: "PUT", body: JSON.stringify({ mcpServers: [{ name: "gh", command: "npx", env: { GITHUB_TOKEN: "ghp_file_secret" } }] }) });
    expect(saved.status).toBe(200);
    await writeFile(join(dataDir, "connection.json"), JSON.stringify({ token: "connection-secret" }));
    await symlink(join(dataDir, "settings.json"), join(home, "innocent.json"));
    return { app, home, dataDir };
  }

  const forbidden = async (response: Response) => {
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "remote_forbidden" } });
  };

  it("cannot add the data dir, or a place inside it, as a project", async () => {
    const { app, dataDir } = await homeWithDataDir();
    for (const repoPath of [dataDir, join(dataDir, "threads"), join(dataDir, "worktrees")]) {
      await forbidden(await asRemote(app, "/api/projects", { method: "POST", body: JSON.stringify({ repoPath }) }));
    }
    expect(await (await request(app, "/api/projects")).json()).toEqual({ projects: [] });
  });

  it("opens the task's own files, and none of the data dir's, whichever route and however named", async () => {
    const { app, home } = await homeWithDataDir();
    // Adding a project by typing its path stays a remote feature, the home directory included.
    const created = await asRemote(app, "/api/projects", { method: "POST", body: JSON.stringify({ repoPath: home }) });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };
    const thread = (await (await asRemote(app, "/api/threads", { method: "POST", body: JSON.stringify({ projectId: project.id, engine: "vgent" }) })).json()) as { id: string };

    const content = await asRemote(app, `/api/threads/${thread.id}/files/content?path=notes.md`);
    expect(await content.json()).toMatchObject({ content: "mine\n" });
    expect((await asRemote(app, `/api/threads/${thread.id}/files/raw?path=notes.md`)).status).toBe(200);

    for (const path of [".vgent/settings.json", ".vgent/connection.json", "innocent.json", join(home, ".vgent", "settings.json")]) {
      const query = encodeURIComponent(path);
      if (!path.startsWith("/")) await forbidden(await asRemote(app, `/api/threads/${thread.id}/files/content?path=${query}`));
      await forbidden(await asRemote(app, `/api/threads/${thread.id}/files/raw?path=${query}`));
      await forbidden(await asRemote(app, `/api/threads/${thread.id}/files/download`, { method: "POST", body: JSON.stringify({ path }) }));
    }
    // The diff of a file the task's repo has not seen yet is its whole text.
    await forbidden(await asRemote(app, `/api/threads/${thread.id}/changes/file?path=${encodeURIComponent(".vgent/settings.json")}`));

    // At the machine nothing changes.
    const local = await request(app, `/api/threads/${thread.id}/files/content?path=${encodeURIComponent(".vgent/settings.json")}`);
    expect(await local.text()).toContain("ghp_file_secret");
  });

  it("still opens a 无项目 task's files, which live in the data dir", async () => {
    const { app, dataDir } = await homeWithDataDir();
    const thread = (await (await asRemote(app, "/api/threads", { method: "POST", body: JSON.stringify({ projectId: "no-project", engine: "vgent" }) })).json()) as { id: string };
    await mkdir(join(dataDir, "scratch", thread.id), { recursive: true });
    await writeFile(join(dataDir, "scratch", thread.id, "answer.md"), "42\n");
    const response = await asRemote(app, `/api/threads/${thread.id}/files/content?path=answer.md`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "42\n" });
  });
});
