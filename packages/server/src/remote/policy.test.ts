import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { carriesSettings, createHostStores, isHostOnly, REDACTED, redactSettingsForRemote } from "./policy.js";

describe("isHostOnly", () => {
  it("keeps what a remote session is for", () => {
    for (const [method, path] of [
      ["GET", "/api/state"],
      ["GET", "/api/threads"],
      ["POST", "/api/threads"],
      ["POST", "/api/chat/abc"],
      ["POST", "/api/chat/abc/stop"],
      ["GET", "/api/chat/abc/stream"],
      ["POST", "/api/threads/abc/queue"],
      ["GET", "/api/threads/abc/files/raw"],
      ["POST", "/api/threads/abc/files/download"],
      ["POST", "/api/threads/abc/integrate"],
      ["POST", "/api/projects"],
      ["DELETE", "/api/threads/abc"],
      ["PUT", "/api/drafts/abc"],
      ["GET", "/api/settings"],
      ["GET", "/api/providers"],
      ["GET", "/api/engines/vgent/models"],
      ["PUT", "/api/settings/model-picks"],
      ["PUT", "/api/settings/provider-order"],
    ] as const) {
      expect(isHostOnly(method, path), `${method} ${path}`).toBe(false);
    }
  });

  it("keeps machine setup at the machine, whatever the verb", () => {
    for (const [method, path] of [
      ["GET", "/api/remote"],
      ["POST", "/api/remote"],
      ["POST", "/api/projects/pick"],
      ["GET", "/api/computer-use/cua/status"],
      ["POST", "/api/computer-use/cua/start"],
      ["POST", "/api/settings/allowlist"],
      ["DELETE", "/api/settings/allowlist/bash"],
      // Web access and language servers for the agents: what this machine lets them reach.
      ["PUT", "/api/settings/engine-options"],
    ] as const) {
      expect(isHostOnly(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("lets a remote session see which accounts there are, and leaves signing in, out and switching at the machine", () => {
    expect(isHostOnly("GET", "/api/accounts")).toBe(false);
    for (const [method, path] of [
      ["POST", "/api/accounts/login"],
      // The login under way, device code and all.
      ["GET", "/api/accounts/login"],
      ["DELETE", "/api/accounts/login"],
      ["DELETE", "/api/accounts/claude"],
      ["PUT", "/api/accounts/claude/uses"],
      ["POST", "/api/accounts"],
    ] as const) {
      expect(isHostOnly(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("lets a remote session read providers, subscriptions and runtimes but not change them", () => {
    for (const path of ["/api/providers", "/api/providers/catalog", "/api/subscriptions", "/api/runtimes"]) {
      expect(isHostOnly("GET", path), `GET ${path}`).toBe(false);
    }
    for (const [method, path] of [
      ["POST", "/api/providers"],
      ["PATCH", "/api/providers/openai"],
      ["DELETE", "/api/providers/openai"],
      ["POST", "/api/providers/discover"],
      ["PUT", "/api/subscriptions/codex/models"],
      ["POST", "/api/runtimes/claude-code/upgrade"],
      ["POST", "/api/runtimes/check"],
      ["POST", "/api/runtimes/opencode/install"],
      ["POST", "/api/runtimes/native-codex/install"],
      ["POST", "/api/runtimes/application/check"],
    ] as const) {
      expect(isHostOnly(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("judges a settings write by the fields it touches", () => {
    expect(isHostOnly("PUT", "/api/settings", { theme: "dark", density: "compact", defaultEngine: "codex" })).toBe(false);
    for (const field of ["runMode", "allowlist", "mcpServers", "computerUseProvider", "autoUpgradeRuntimes", "worktreeMaxCount", "systemNotifications"]) {
      expect(isHostOnly("PUT", "/api/settings", { [field]: null }), field).toBe(true);
      // One forbidden field is enough, next to any number of allowed ones.
      expect(isHostOnly("PUT", "/api/settings", { theme: "dark", [field]: null }), `theme + ${field}`).toBe(true);
    }
  });

  it("cannot be talked past by the shape of the route", () => {
    expect(isHostOnly("put", "/api/settings", { runMode: "allow-all" })).toBe(true);
    expect(isHostOnly("delete", "/api/providers/x")).toBe(true);
  });
});

describe("redactSettingsForRemote", () => {
  const servers = [
    { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--token", "ghp_secret", "--api-key=sk-secret", "--verbose"], env: { GITHUB_TOKEN: "ghp_secret", HOME: "/Users/me" } },
    { name: "docs", url: "https://user:pw@docs.example.com/mcp?key=sk-secret#frag", transport: "sse" as const },
    { name: "plain", command: "node" },
  ];

  it("keeps who the servers are and how they are started, and none of what unlocks them", () => {
    const shown = redactSettingsForRemote({ mcpServers: servers });
    expect(shown.mcpServers).toEqual([
      { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--token", REDACTED, `--api-key=${REDACTED}`, "--verbose"], env: { GITHUB_TOKEN: REDACTED, HOME: REDACTED } },
      { name: "docs", url: "https://docs.example.com", transport: "sse" },
      { name: "plain", command: "node" },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/ghp_secret|sk-secret|user:pw|\/Users\/me/);
  });

  it("cuts every address down to scheme, host and port, positional or after a flag", () => {
    const shown = redactSettingsForRemote({
      mcpServers: [{ name: "pg", command: "mcp-postgres", args: ["postgresql://user:hunter2@db.internal:5432/app?sslmode=require", "--url=https://u:p@api.example.com/v1?k=1", "--verbose", "--name=plain"] }],
    });
    expect(shown.mcpServers).toEqual([
      { name: "pg", command: "mcp-postgres", args: ["postgresql://db.internal:5432", "--url=https://api.example.com", "--verbose", `--name=${REDACTED}`] },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/hunter2|u:p@|sslmode|k=1|app|v1/);
  });

  it("hides a secret that lives in an address's path, as a server's url or as an argument", () => {
    const shown = redactSettingsForRemote({
      mcpServers: [
        { name: "zapier", url: "https://mcp.zapier.com/api/mcp/s/zap-path-secret/mcp" },
        { name: "bridge", command: "npx", args: ["-y", "mcp-remote", "https://mcp.zapier.com/api/mcp/s/zap-path-secret/mcp"] },
        { name: "slack", command: "notify", args: ["--webhook", "https://hooks.slack.com/services/T000/B000/slack-path-secret"] },
      ],
    });
    expect(shown.mcpServers).toEqual([
      { name: "zapier", url: "https://mcp.zapier.com" },
      { name: "bridge", command: "npx", args: ["-y", "mcp-remote", "https://mcp.zapier.com"] },
      { name: "slack", command: "notify", args: ["--webhook", "https://hooks.slack.com"] },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/path-secret|T000/);
  });

  it("hides the value after a flag that names a secret, whatever it looks like, and keeps a flag after it", () => {
    const shown = redactSettingsForRemote({
      mcpServers: [
        {
          name: "spring",
          command: "java",
          args: ["-jar", "app.jar", "--spring.datasource.password=hunter2", "--spring.datasource.url", "jdbc:x", "--auth-token", "https://u:p@api.example.com/v1?k=1", "--password", "plainletters", "--token", "--verbose"],
        },
      ],
    });
    expect(shown.mcpServers).toEqual([
      {
        name: "spring",
        command: "java",
        args: [REDACTED, "app.jar", `--spring.datasource.password=${REDACTED}`, "--spring.datasource.url", REDACTED, "--auth-token", REDACTED, "--password", REDACTED, "--token", "--verbose"],
      },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/hunter2|u:p@|k=1|api\.example|plainletters|jdbc/);
  });

  it("catches what a docker-style server carries as `-e NAME=value`, and a header given as an argument", () => {
    const shown = redactSettingsForRemote({
      mcpServers: [
        {
          name: "gh",
          command: "docker",
          args: [
            "run", "-i", "--rm",
            "-e", "GITHUB_TOKEN=ghp_secret_1", "--env=API_KEY=sk-secret-2", "-eSLACK_BOT_TOKEN=xoxb-secret-3",
            "-e", "HOME=/root", "-e", "DATABASE_URL=postgres://u:pw-secret-4@db/x?sslmode=require",
            "--header", "Authorization: Bearer bearer-secret-5", "-H", "X-Api-Key: key-secret-6",
            "image",
          ],
        },
      ],
    });
    expect(shown.mcpServers).toEqual([
      {
        name: "gh",
        command: "docker",
        args: [
          "run", "-i", "--rm",
          "-e", `GITHUB_TOKEN=${REDACTED}`, `--env=${REDACTED}`, REDACTED,
          "-e", `HOME=${REDACTED}`, "-e", "DATABASE_URL=postgres://db",
          "--header", REDACTED, "-H", REDACTED,
          "image",
        ],
      },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/secret-\d|pw-|sslmode|\/root/);
  });

  it("hides the shapes a list of secret words cannot see: a name that says nothing, JSON, a cookie, a value stuck to its flag", () => {
    const shown = redactSettingsForRemote({
      mcpServers: [
        {
          name: "odd",
          command: "server",
          args: [
            "-e", "GH_PAT=ghp_pat_secret",
            "--config", '{"apiKey":"sk-json-secret"}',
            "--cookie-jar", "Cookie: sid=cookie-secret",
            "-phunter2",
            "--region", "a3f9c2d1e4b5f6a7",
            "sid=plain-secret",
          ],
        },
      ],
    });
    expect(shown.mcpServers).toEqual([
      {
        name: "odd",
        command: "server",
        args: ["-e", `GH_PAT=${REDACTED}`, "--config", REDACTED, "--cookie-jar", REDACTED, REDACTED, "--region", REDACTED, `sid=${REDACTED}`],
      },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/ghp_|sk-json|cookie-secret|hunter2|a3f9|plain-secret/);
  });

  it("keeps bare flags and package specs as they are, and nothing that only looks close", () => {
    const kept = ["-y", "--stdio", "--read-only", "@scope/name", "@upstash/context7-mcp@latest", "mcp-server-fetch", "server-github@1.2.3", "mcp_server_time", "stdio"];
    const hidden = ["-jar", "--", "-", "server-v2", "Name", "./server.js", "/Users/me/project", "ghcr.io/github/github-mcp-server", "name@SECRET", "@scope", ""];
    const shown = redactSettingsForRemote({ mcpServers: [{ name: "x", command: "npx", args: [...kept, ...hidden, 42] }] });
    expect(shown.mcpServers).toEqual([{ name: "x", command: "npx", args: [...kept, ...hidden.map(() => REDACTED), REDACTED] }]);
  });

  it("fails closed on what it does not recognise: unknown fields, entries that are not servers, a list that is not a list", () => {
    const shown = redactSettingsForRemote({
      theme: "dark",
      apiToken: "top-level-secret",
      mcpServers: [
        { name: "http", url: "https://api.example.com/mcp", transport: "sse", headers: { Authorization: "Bearer header-secret" } },
        { name: "local", command: "node", env: { A: "env-secret" }, cwd: "/secret/place", extra: "extra-secret" },
        { name: "neither", transport: "http" },
        { command: "nameless", env: { B: "nameless-secret" } },
        "just a string",
        null,
      ],
    });
    expect(shown).toEqual({
      theme: "dark",
      mcpServers: [
        { name: "http", url: "https://api.example.com", transport: "sse" },
        { name: "local", command: "node", env: { A: REDACTED } },
      ],
    });
    expect(redactSettingsForRemote({ mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: "map-secret" } } } })).toEqual({});
    for (const odd of [undefined, null, "settings", 42, ["a"]]) expect(redactSettingsForRemote(odd)).toEqual({});
  });

  it("does not touch the original, and shows settings without servers as they are", () => {
    const original = { mcpServers: servers, theme: "dark" };
    redactSettingsForRemote(original);
    expect(servers[0]).toMatchObject({ env: { GITHUB_TOKEN: "ghp_secret" } });
    const bare = {
      defaultEngine: "vgent",
      runMode: "allow-reads",
      allowlist: ["read"],
      theme: "dark",
      modelPicks: { m: { engine: "codex" } },
      engineOptions: { opencode: { web: false, lsp: false }, codex: { webSearch: "live" } },
    };
    expect(redactSettingsForRemote(bare)).toEqual(bare);
  });

  it("hides an address it cannot read rather than passing it on", () => {
    expect(redactSettingsForRemote({ mcpServers: [{ name: "odd", url: "not a url ?token=abc" }] }).mcpServers).toEqual([{ name: "odd", url: REDACTED }]);
  });

  it("knows which routes answer with the settings", () => {
    for (const path of ["/api/settings", "/api/settings/model-picks", "/api/settings/provider-order"]) expect(carriesSettings(path), path).toBe(true);
    for (const path of ["/api/state", "/api/settingsx", "/api/threads"]) expect(carriesSettings(path), path).toBe(false);
  });
});

describe("createHostStores", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A home with the data dir, a project, and the two CLIs' stores in it. */
  async function home() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vgent-host-stores-")));
    dirs.push(root);
    const dataDir = join(root, ".vgent");
    const project = join(root, "project");
    for (const dir of [
      dataDir,
      join(dataDir, "worktrees", "t1"),
      join(dataDir, "scratch", "t2"),
      join(dataDir, "attachments", "t3"),
      join(dataDir, "outputs", "t4"),
      join(dataDir, "remote"),
      join(dataDir, "accounts", "claude-2"),
      join(dataDir, "harness", "codex", "codex-home"),
      project,
      join(root, ".codex"),
      join(root, ".claude"),
      join(root, ".local", "share", "opencode"),
    ]) {
      await mkdir(dir, { recursive: true });
    }
    for (const file of [
      "settings.json",
      "providers.json",
      "connection.json",
      "accounts.json",
      "remote/github.json",
      "accounts/claude-2/.credentials.json",
      "harness/codex/codex-home/auth.json",
      "worktrees/t1/a.ts",
      "scratch/t2/b.md",
      "attachments/t3/c.png",
      "outputs/t4/d.json",
    ]) {
      await writeFile(join(dataDir, file), "x");
    }
    await writeFile(join(project, "readme.md"), "x");
    await writeFile(join(root, ".codex", "auth.json"), "x");
    await writeFile(join(root, ".codex", "config.toml"), "x");
    await writeFile(join(root, ".claude", ".credentials.json"), "x");
    await writeFile(join(root, ".claude", "CLAUDE.md"), "x");
    await writeFile(join(root, ".local", "share", "opencode", "auth.json"), "x");
    await writeFile(join(root, ".local", "share", "opencode", "log.txt"), "x");
    const stores = createHostStores({ dataDir, env: {}, home: root });
    return { root, dataDir, project, stores };
  }

  const refused = { status: 403, code: "remote_forbidden" };

  it("refuses the data dir's own files, however they are named, and lets the task areas through", async () => {
    const { root, dataDir, project, stores } = await home();
    for (const [base, path] of [
      [dataDir, "settings.json"],
      [dataDir, "providers.json"],
      [dataDir, "remote/github.json"],
      [root, ".vgent/connection.json"],
      // The signed-in accounts' own CLI homes, and the engines' private ones.
      [dataDir, "accounts.json"],
      [dataDir, "accounts/claude-2/.credentials.json"],
      [dataDir, "harness/codex/codex-home/auth.json"],
      [project, join(dataDir, "settings.json")],
    ] as const) {
      await expect(stores.assertReadable(base, path), `${base} ${path}`).rejects.toMatchObject(refused);
    }
    for (const [base, path] of [
      [join(dataDir, "worktrees", "t1"), "a.ts"],
      [join(dataDir, "scratch", "t2"), "b.md"],
      [dataDir, "attachments/t3/c.png"],
      [root, ".vgent/outputs/t4/d.json"],
      [project, "readme.md"],
      [root, "project/readme.md"],
    ] as const) {
      await expect(stores.assertReadable(base, path), `${base} ${path}`).resolves.toBeUndefined();
    }
  });

  it("follows a link to where it really points", async () => {
    const { dataDir, project, stores } = await home();
    await symlink(join(dataDir, "settings.json"), join(project, "innocent.json"));
    await symlink(dataDir, join(project, "data"));
    await expect(stores.assertReadable(project, "innocent.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(project, "data/providers.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(project, "data/worktrees/t1/a.ts")).resolves.toBeUndefined();
  });

  it("refuses Codex's home and Claude Code's credentials, wherever their env puts them", async () => {
    const { root, stores } = await home();
    await expect(stores.assertReadable(root, ".codex/auth.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(root, ".codex/config.toml")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(root, ".claude/.credentials.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(root, ".claude/CLAUDE.md")).resolves.toBeUndefined();

    const moved = createHostStores({ dataDir: join(root, ".vgent"), env: { CODEX_HOME: join(root, "project"), CLAUDE_CONFIG_DIR: join(root, "project") }, home: join(root, "elsewhere") });
    await writeFile(join(root, "project", ".credentials.json"), "x");
    await expect(moved.assertReadable(root, "project/readme.md")).rejects.toMatchObject(refused);
    await expect(moved.assertReadable(root, ".codex/auth.json")).resolves.toBeUndefined();
  });

  it("refuses OpenCode's auth file, and only that, wherever XDG_DATA_HOME puts it", async () => {
    const { root, stores } = await home();
    await expect(stores.assertReadable(root, ".local/share/opencode/auth.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(join(root, ".local", "share"), "opencode/auth.json")).rejects.toMatchObject(refused);
    await expect(stores.assertReadable(root, ".local/share/opencode/log.txt")).resolves.toBeUndefined();

    await mkdir(join(root, "xdg", "opencode"), { recursive: true });
    await writeFile(join(root, "xdg", "opencode", "auth.json"), "x");
    await expect(stores.assertReadable(root, "xdg/opencode/auth.json")).resolves.toBeUndefined();
    const moved = createHostStores({ dataDir: join(root, ".vgent"), env: { XDG_DATA_HOME: join(root, "xdg") }, home: root });
    await expect(moved.assertReadable(root, "xdg/opencode/auth.json")).rejects.toMatchObject(refused);
    // The default one is still a login, whichever OpenCode reads today.
    await expect(moved.assertReadable(root, ".local/share/opencode/auth.json")).rejects.toMatchObject(refused);
  });

  it("refuses the data dir and Codex's home, or a place inside them, as a project — and nothing around them", async () => {
    const { root, dataDir, project, stores } = await home();
    for (const path of [dataDir, join(dataDir, "worktrees"), join(dataDir, "worktrees", "t1"), join(dataDir, "remote"), join(root, ".codex"), join(dataDir, "nothing-here-yet")]) {
      await expect(stores.assertRegistrable(path), path).rejects.toMatchObject(refused);
    }
    await symlink(dataDir, join(root, "shortcut"));
    await expect(stores.assertRegistrable(join(root, "shortcut"))).rejects.toMatchObject(refused);
    for (const path of [root, project, join(root, ".claude")]) await expect(stores.assertRegistrable(path), path).resolves.toBeUndefined();
  });

  it("refuses the engines' runtimes in ~/.vgent/harness even when the data dir is somewhere else", async () => {
    const { root } = await home();
    const moved = createHostStores({ dataDir: join(root, "scratch-data"), env: {}, home: root });
    await expect(moved.assertReadable(root, ".vgent/harness/codex/codex-home/auth.json")).rejects.toMatchObject(refused);
    await expect(moved.assertRegistrable(join(root, ".vgent", "harness"))).rejects.toMatchObject(refused);
    // The rest of the default data dir is just another folder to that instance.
    await expect(moved.assertReadable(root, ".vgent/worktrees/t1/a.ts")).resolves.toBeUndefined();
  });
});
