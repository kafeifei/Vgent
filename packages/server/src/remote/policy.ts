import type { McpServerConfig } from "@vgent/engine";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { VgentServerError } from "../errors.js";
import type { Settings } from "../types.js";

/**
 * What a remote session may not do.
 *
 * The remote page drives tasks on this machine — chat, stop, approve, read a
 * file — and that is the whole point of it. How the machine is *allowed to
 * behave* is another matter, and it stays with whoever sits at it: the run mode,
 * the standing approvals, which programs start as MCP servers, what the agents
 * may reach on their own (the web, a language server), whether the desktop can
 * be driven, which credentials exist and which accounts are signed in, and what
 * software gets installed. Otherwise one hijacked GitHub session could leave
 * the machine on 「全自动」, or start a program of its choosing, long after it
 * has gone.
 *
 * The gateway marks every request it forwards with {@link REMOTE_REQUEST_HEADER};
 * the local API applies this policy to marked requests. A client cannot lift the
 * mark: the gateway sets it itself, and only ever strips or overwrites what the
 * remote side sent. (A request that carries the mark without coming through the
 * gateway is merely restricted more.)
 */

/** Set by the remote gateway on every request it forwards to the local API. */
export const REMOTE_REQUEST_HEADER = "x-vgent-remote";

/** The answer to whatever this policy refuses. */
export const remoteForbidden = (message = "此操作需在主机上完成"): VgentServerError =>
  new VgentServerError({ message, status: 403, code: "remote_forbidden" });

/**
 * The settings a remote session may change: how its own tasks start and look.
 * Every other field of `PUT /api/settings` is policy about this machine.
 */
const REMOTE_SETTINGS = new Set(["defaultEngine", "defaultModel", "defaultWorkspace", "theme", "density"]);

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Never available remotely, reads included: they are about this machine's own
 * setup. Under `/api/accounts/` that is signing in, out and switching — and the
 * login in progress, whose device code would let the far side finish it — as
 * the gateway already says; the list itself stays readable, below.
 */
const HOST_ONLY_PATHS: readonly RegExp[] = [
  /^\/api\/remote(?:\/|$)/,
  /^\/api\/projects\/pick$/,
  /^\/api\/computer-use(?:\/|$)/,
  /^\/api\/settings\/allowlist(?:\/|$)/,
  /^\/api\/settings\/engine-options(?:\/|$)/,
  /^\/api\/accounts\//,
];

/** Readable remotely (the model picker needs them), writable only at the machine. */
const HOST_ONLY_WRITES: readonly RegExp[] = [
  /^\/api\/providers(?:\/|$)/,
  /^\/api\/subscriptions(?:\/|$)/,
  /^\/api\/runtimes(?:\/|$)/,
  /^\/api\/accounts$/,
];

/** The one route whose answer depends on the body: which settings a `PUT` touches. */
export const isSettingsWrite = (method: string, path: string): boolean => method === "PUT" && path === "/api/settings";

/**
 * Whether a remote session may not make this request. `body` is the parsed JSON
 * body, only consulted for {@link isSettingsWrite}; without one the request is
 * judged on its route alone.
 */
export function isHostOnly(method: string, path: string, body?: unknown): boolean {
  const verb = method.toUpperCase();
  if (HOST_ONLY_PATHS.some((pattern) => pattern.test(path))) return true;
  if (!READS.has(verb) && HOST_ONLY_WRITES.some((pattern) => pattern.test(path))) return true;
  if (isSettingsWrite(verb, path) && typeof body === "object" && body !== null) {
    return Object.keys(body).some((key) => !REMOTE_SETTINGS.has(key));
  }
  return false;
}

// --- files -----------------------------------------------------------------

/**
 * The directories under the data dir that are one task's own, and that its
 * pages read files from: its worktree, a 无项目 task's scratch directory, what
 * was attached to it and what its turns put aside. Everything else there —
 * `settings.json` with the MCP servers' env, `providers.json` with API keys,
 * `connection.json` with this server's token, the relay's credentials, the
 * signed-in accounts' own CLI homes under `accounts/`, the engines' runtimes
 * and private homes under `harness/` — is this machine's own.
 */
const TASK_AREAS = ["worktrees", "scratch", "attachments", "outputs"] as const;

export interface HostStoresOptions {
  dataDir: string;
  /** Where `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_DATA_HOME` are read from. Defaults to `process.env`, at every check. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the user's home directory. */
  home?: string;
}

/**
 * Where this machine keeps what unlocks things, as far as a remote session's
 * way in is concerned. A task's files are read from far away, and a project
 * can be added there by typing a path — so without this, adding the data dir
 * (or the home directory it sits in) as a project and opening `settings.json`
 * would hand over every secret the settings page keeps from it. The same goes
 * for the stores of the CLIs whose logins Vgent uses: all of Codex's home
 * (`auth.json`, and a `config.toml` whose MCP servers carry env of their own),
 * Claude Code's `.credentials.json` — only that file, since the rest of
 * `~/.claude` is the user's own skills and instructions — and OpenCode's
 * `auth.json`, which its engine signs in with (the rest of its data directory
 * is its sessions and logs).
 *
 * Every check follows links to the real path, so a symlink in a project that
 * points into one of these is refused like the file itself.
 */
export interface HostStores {
  /** Refuses (403 `remote_forbidden`) a file named inside a task — `path` absolute, or relative to `root` — that is in one of them. */
  assertReadable(root: string, path: string): Promise<void>;
  /** Refuses a directory to add as a project that is the data dir, Codex's home or the engines' runtimes, or inside one. */
  assertRegistrable(path: string): Promise<void>;
}

/** `path` with every link followed; one that is not there stays as written. */
const real = (path: string): Promise<string> => realpath(path).catch(() => path);

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

export function createHostStores(options: HostStoresOptions): HostStores {
  const dataDir = resolve(options.dataDir);
  // Resolved at every check: the task areas come to be with the tasks, and the
  // CLIs' homes may be moved by their env while the server runs.
  const stores = async () => {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    // OpenCode signs in from `$XDG_DATA_HOME/opencode` when that is set, else from
    // `~/.local/share/opencode`. Both are refused: a file in either is a login.
    const openCodeHomes = [...(env.XDG_DATA_HOME ? [resolve(env.XDG_DATA_HOME)] : []), join(home, ".local", "share")];
    const [data, areas, codex, claude, openCode, runtimes] = await Promise.all([
      real(dataDir),
      Promise.all(TASK_AREAS.map((area) => real(join(dataDir, area)))),
      real(resolve(env.CODEX_HOME ?? join(home, ".codex"))),
      real(join(resolve(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")), ".credentials.json")),
      Promise.all(openCodeHomes.map((dir) => real(join(dir, "opencode", "auth.json")))),
      // The engines' runtimes and their private homes stay in `~/.vgent/harness`
      // even when the data dir is moved (`--data-dir`, `VGENT_DATA_DIR`).
      real(join(home, ".vgent", "harness")),
    ]);
    return { data, areas, codex, claude, openCode, runtimes };
  };

  return {
    async assertReadable(root, path) {
      const target = await real(resolve(await real(resolve(root)), path));
      const { data, areas, codex, claude, openCode, runtimes } = await stores();
      const ownedByTask = areas.some((area) => within(target, area));
      if ((within(target, data) && !ownedByTask) || within(target, codex) || within(target, runtimes) || target === claude || openCode.includes(target)) {
        throw remoteForbidden("这个文件只能在主机上查看");
      }
    },
    async assertRegistrable(path) {
      const target = await real(resolve(path));
      const { data, codex, runtimes } = await stores();
      if (within(target, data) || within(target, codex) || within(target, runtimes)) throw remoteForbidden("这个目录只能在主机上添加为项目");
    },
  };
}

// --- settings --------------------------------------------------------------

/** What stands in for anything a remote session is not shown. */
export const REDACTED = "••••••••";

/** A word in a name that says its value is a secret (`GITHUB_TOKEN`, `--password`, `X-Api-Key`). */
const SECRET_WORD = /token|key|secret|pass|pwd|auth|bearer|credential|cookie|session|private|signature/i;

/** A flag that names a secret (`--token`, `--spring.datasource.password`): whatever follows it is one. */
const SECRET_FLAG = new RegExp(`^--?[\\w.-]*(?:${SECRET_WORD.source})[\\w.-]*$`, "i");

/**
 * A flag on its own: one letter after one dash (`-y`), or words joined by `-`
 * or `.` after two (`--stdio`, `--read-only`, `--spring.datasource.url`).
 * Not `-jar` or `-Xmx1g`: after one dash, more than a letter may be a value
 * stuck to it (`-pPASSWORD`).
 */
const BARE_FLAG = /^(?:-[A-Za-z]|--[A-Za-z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)*)$/;

/** A version or dist-tag after `name@`: `1`, `1.2.3`, `1.2.3-beta.1`, `latest`. */
const VERSION = String.raw`(?:\d+(?:\.\d+){0,2}(?:-[a-z]+(?:\.\d+)?)?|[a-z]+)`;

/**
 * A package to run: `@scope/name`, or an unscoped name of lowercase words only
 * (`server-github`, `mcp_server_time`), either with a version. The unscoped
 * kind has no digit in it — a digit is what gives most tokens away, so
 * `server-v2` is hidden with them.
 */
const PACKAGE = new RegExp(`^(?:@[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*|[a-z]+(?:[-._][a-z]+)*)(?:@${VERSION})?$`);

/** Anything shaped like `scheme://…`: an endpoint or a database DSN. */
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A name, then `=`: an environment variable's (`GITHUB_TOKEN=…`) or a long flag's (`--config=…`). */
const ASSIGNMENT = /^([A-Za-z_][\w.]*|--[A-Za-z][\w.-]*)=([\s\S]*)$/;

/** An address down to where it points, `scheme://host[:port]`: credentials, path, query and fragment can all carry a secret. */
function bareAddress(address: string): string {
  try {
    const url = new URL(address);
    return url.host === "" ? REDACTED : `${url.protocol}//${url.host}`;
  } catch {
    return REDACTED;
  }
}

/**
 * One launch argument as a remote session sees it (`previous` is the one
 * before it). Kept only where it is plainly not a secret, judged on its own
 * text: a bare flag, a package spec, an address cut down to its host, and the
 * name half of `NAME=value` / `--flag=value` — the value half only when it is
 * an address, under a name that does not say secret. Anything after a flag
 * that says secret goes, whatever it looks like; so does everything else —
 * a value after an ordinary flag, a path, JSON, a header, `-pPASSWORD`.
 */
function shownArg(arg: unknown, previous: unknown): string {
  if (typeof arg !== "string") return REDACTED;
  if (typeof previous === "string" && SECRET_FLAG.test(previous) && !BARE_FLAG.test(arg)) return REDACTED;
  if (BARE_FLAG.test(arg) || PACKAGE.test(arg)) return arg;
  if (ADDRESS.test(arg)) return bareAddress(arg);
  const assignment = ASSIGNMENT.exec(arg);
  if (assignment != null) {
    const [, name = "", value = ""] = assignment;
    return `${name}=${!SECRET_WORD.test(name) && ADDRESS.test(value) ? bareAddress(value) : REDACTED}`;
  }
  return REDACTED;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One MCP server as a remote session sees it: its name, its transport, the
 * command it is started with, the names of its env but none of the values,
 * the arguments `shownArg` lets through, the host its address points at.
 * Built anew from those fields, so anything else an entry carries (`headers`)
 * stays behind; an entry that is not a server at all is dropped.
 */
function redactedServer(entry: unknown): McpServerConfig | undefined {
  if (!isRecord(entry)) return undefined;
  const { name, command, args, env, url, transport } = entry;
  if (typeof name !== "string") return undefined;
  if (typeof command === "string") {
    return {
      name,
      command,
      ...(Array.isArray(args) ? { args: args.map((arg, index) => shownArg(arg, args[index - 1])) } : {}),
      ...(isRecord(env) ? { env: Object.fromEntries(Object.keys(env).map((key) => [key, REDACTED])) } : {}),
    };
  }
  if (typeof url === "string") return { name, url: bareAddress(url), ...(transport === "http" || transport === "sse" ? { transport } : {}) };
  return undefined;
}

/** A list that is not a list is not shown at all. */
const redactedServers = (value: unknown): McpServerConfig[] | undefined =>
  Array.isArray(value) ? value.flatMap((entry) => redactedServer(entry) ?? []) : undefined;

const asStored = (value: unknown): unknown => value;

/**
 * Every field of the settings and how a remote session is shown it: as it is,
 * or — the MCP servers — without their secrets. A field missing here is not
 * shown at all, so whatever else a hand-edited file carries stays at the
 * machine; typed over `Settings`, so a new field does not compile until it is
 * placed.
 */
const REMOTE_VIEW: { readonly [K in keyof Settings]-?: (value: unknown) => unknown } = {
  defaultEngine: asStored,
  runMode: asStored,
  allowlist: asStored,
  defaultModel: asStored,
  hiddenModels: asStored,
  systemNotifications: asStored,
  autoUpgradeRuntimes: asStored,
  modelPicks: asStored,
  providerOrder: asStored,
  mcpServers: redactedServers,
  // Switches and one three-way choice per engine, nothing that unlocks anything.
  engineOptions: asStored,
  computerUseProvider: asStored,
  worktreeMaxCount: asStored,
  defaultWorkspace: asStored,
  theme: asStored,
  density: asStored,
};

/**
 * The settings as a remote session may read them. An MCP server carries what
 * it is started with: `env` is where tokens usually live, an address may hold
 * one in its path or query, a launch argument may be one in any shape. Reading
 * them is not what the remote page is for — changing them is host-only for the
 * same reason — so this fails closed: each server keeps its name, transport and
 * command, and of the rest only what is plainly not a secret. Whatever it does
 * not recognise, top level or inside a server, is left out rather than passed on.
 */
export function redactSettingsForRemote(settings: unknown): Partial<Settings> {
  const view: Record<string, unknown> = {};
  if (!isRecord(settings)) return view;
  for (const [field, show] of Object.entries(REMOTE_VIEW)) {
    if (!Object.hasOwn(settings, field)) continue;
    const shown = show(settings[field]);
    if (shown !== undefined) view[field] = shown;
  }
  return view as Partial<Settings>;
}

/**
 * Whether a route answers with the settings document (`GET` and `PUT /api/settings`
 * and the edits under it). The state stream carries the settings too, but is not a
 * route of this kind: `app.ts` builds a redacted copy of it for a remote client.
 */
export const carriesSettings = (path: string): boolean => path === "/api/settings" || path.startsWith("/api/settings/");
