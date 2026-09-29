import { createRemoteService, type RemoteService } from "./remote/service.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { acquireInstanceLock, INSTANCE_LOCKED_EXIT_CODE, InstanceLockedError } from "./instance-lock.js";
import { DEFAULT_DATA_DIR, resolveDataDir } from "./paths.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
import { consoleLogger, type ConnectionInfo } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 7412;
/** Where the Vite dev server serves `apps/web`; printed so a human can just click it. */
const DEV_WEB_URL = "http://localhost:5173";

export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

/** `--foo` → true, `--no-foo` → false, neither present → undefined (caller picks the default). */
export function boolFlag(argv: readonly string[], name: string): boolean | undefined {
  if (argv.includes(`--no-${name}`)) return false;
  if (argv.includes(`--${name}`)) return true;
  return undefined;
}

/** `apps/web/dist` next to this file, however deep `main.{ts,js}` sits under `packages/server/{src,dist}`. */
export function defaultWebDist(mainUrl: string): string {
  return fileURLToPath(new URL("../../../apps/web/dist", mainUrl));
}

/**
 * An explicit `--web-dist`/`VGENT_WEB_DIST` always wins. Otherwise the build
 * output next to this file is used, but only when it actually looks built —
 * a fresh checkout that hasn't run `pnpm build` yet should stay API-only
 * rather than serve a directory with nothing in it.
 */
export function resolveWebDist(explicit: string | undefined, defaultDir: string): string | undefined {
  if (explicit != null) return explicit;
  return existsSync(join(defaultDir, "index.html")) ? defaultDir : undefined;
}

/** Default for `--open`: only when there's a human at a TTY, not the desktop shell, and something to open. */
export function shouldOpenBrowser(options: {
  openFlag: boolean | undefined;
  isTTY: boolean;
  desktop: boolean;
  staticServing: boolean;
}): boolean {
  return options.openFlag ?? (options.isTTY && !options.desktop && options.staticServing);
}

/**
 * A startup failure this process knows how to report itself: one stderr line and
 * a dedicated exit code, instead of an unhandled rejection's stack trace.
 * `undefined` means the failure is not ours to translate — rethrow it.
 */
export function describeStartupFailure(error: unknown): { message: string; exitCode: number } | undefined {
  if (!(error instanceof InstanceLockedError)) return undefined;
  return {
    message:
      `Vgent 已在运行（进程 ${error.pid}），数据目录 ${dirname(error.lockPath)} 已被占用。` +
      `请先退出那个 Vgent；确认没有 Vgent 在跑时，可以删除锁文件 ${error.lockPath} 后重试。`,
    exitCode: INSTANCE_LOCKED_EXIT_CODE,
  };
}

/** How often the desktop-mode server checks whether the shell that spawned it is still there. */
const PARENT_POLL_INTERVAL_MS = 1000;

/** `init`/`launchd`. In desktop mode it can only mean the shell is already gone. */
const ADOPTED_PPID = 1;

/**
 * The desktop shell spawns this process directly, so our parent is the shell
 * itself. Killing the shell outright (no SIGTERM, no window close) would
 * otherwise leave us reparented — to launchd, pid 1, on macOS — and running
 * forever, holding the data directory's instance lock. Polling `ppid` is enough
 * to notice: it only ever changes when the parent is gone.
 *
 * A ppid of 1 at the very first sample is the same thing seen too late: the
 * shell died before we got to look, so there is no change left to wait for. That
 * server would be alive, so its lock would never look stale — every later launch
 * would just be told Vgent is already running. Reported on the next tick so the
 * caller's shutdown path is always fully wired by the time it runs.
 */
export function watchParentExit(options: {
  getPpid: () => number;
  onOrphaned: () => void;
  intervalMs?: number;
}): NodeJS.Timeout {
  const initial = options.getPpid();
  const timer = setInterval(() => {
    if (options.getPpid() === initial && initial !== ADOPTED_PPID) return;
    clearInterval(timer);
    options.onOrphaned();
  }, options.intervalMs ?? PARENT_POLL_INTERVAL_MS);
  // Watching must never be the reason this process stays alive.
  timer.unref();
  return timer;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url], () => {});
}

/** The git toplevel containing `cwd`, or `undefined` when it isn't inside a repo (or `git` is unavailable). */
async function detectRepoToplevel(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const dataDir = resolveDataDir(flagValue(argv, "data-dir"));
  const portRaw = flagValue(argv, "port") ?? process.env.VGENT_PORT;
  const port = portRaw != null ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法: ${portRaw}`);
  const downloadsDir = flagValue(argv, "downloads-dir") ?? process.env.VGENT_DOWNLOADS_DIR;
  const webDistRaw = flagValue(argv, "web-dist") ?? process.env.VGENT_WEB_DIST;
  const explicitWebDist = webDistRaw != null && webDistRaw.length > 0 ? resolve(webDistRaw) : undefined;
  const webDist = resolveWebDist(explicitWebDist, defaultWebDist(import.meta.url));
  // The desktop shell drains our stdio into its own log; the token must not land there.
  const desktop = process.env.VGENT_DESKTOP === "1";

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Before `createApp`: loading the store runs migrations and rewrites files, so
  // this process must own the data directory before it touches anything in it.
  const releaseLock = await acquireInstanceLock(dataDir);
  try {
    const token = randomBytes(32).toString("hex");
    let localUrl: string | undefined;
    let remote: RemoteService | undefined;
    if (webDist != null) {
      try {
        remote = createRemoteService({
          dataDir,
          backend: async () => {
            if (!localUrl) throw new Error("Vgent server is not listening");
            return { url: localUrl, token };
          },
        });
      } catch { console.warn("远程控制配置无法读取，本机服务继续运行"); }
    }
    const { app, projects, shutdown } = createApp({
      dataDir,
      token,
      ...(remote != null ? { remote } : {}),
      log: consoleLogger,
      ...(webDist != null ? { webDist } : {}),
      // 「下载」 goes to the user's Downloads folder unless told otherwise — a scratch instance is told otherwise.
      ...(downloadsDir != null && downloadsDir.length > 0 ? { downloadsDir: resolve(downloadsDir) } : {}),
      // The engines' CLIs live in one place per user (`~/.vgent/harness`), and
      // only the instance that owns the default data dir can see every task
      // that uses them. A scratch instance (`--data-dir …`) must not upgrade
      // them behind that instance's back.
      autoUpgradeRuntimes: dataDir === DEFAULT_DATA_DIR,
    });
    const connectionPath = join(dataDir, "connection.json");

    // `--port 0` is the desktop shell's normal case, so the bound port — not the
    // requested one — is what goes into the URL and `connection.json`.
    let server!: ReturnType<typeof serve>;
    const boundPort = await new Promise<number>((resolve_) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => resolve_(info.port));
    });
    const url = `http://127.0.0.1:${boundPort}`;
    localUrl = url;

    await writeJsonAtomic(
      connectionPath,
      { version: 1, url, token, pid: process.pid, createdAt: new Date().toISOString() } satisfies ConnectionInfo,
      { mode: 0o600 },
    );

    console.log(`vgent server listening on ${url}  (token in ${connectionPath})`);
    const webUrl = `${webDist == null ? DEV_WEB_URL : url}/#token=${token}`;
    if (!desktop) console.log(`web: ${webUrl}`);

    // Restore remote access only after the local listener and token are ready.
    void remote?.initialize();

    // `pnpm start` should need zero manual input: register whatever repo the
    // caller pointed at (or is standing inside) as a project up front.
    const repoFlag = flagValue(argv, "repo");
    const repoPath = repoFlag != null ? resolve(repoFlag) : await detectRepoToplevel(process.env.INIT_CWD ?? process.cwd());
    if (repoPath != null) {
      const project = await projects.create({ repoPath }).catch((error: unknown) => {
        console.error("注册项目失败", error);
        return undefined;
      });
      if (project != null) console.log(`project: ${project.repoPath}`);
    }

    if (shouldOpenBrowser({ openFlag: boolFlag(argv, "open"), isTTY: process.stdout.isTTY === true, desktop, staticServing: webDist != null })) {
      openBrowser(webUrl);
    }

    let shuttingDown = false;
    const stop = (recoverRunning = false) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        // Stopping the runs first lets each engine persist its resume state.
        await shutdown({ recoverRunning }).catch((error) => console.error("停止运行中的任务失败", error));
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          // `close` only stops accepting; it then waits for every open socket. The
          // state SSE stream never ends on its own, so without this the process
          // would hang until whoever supervises it loses patience and SIGKILLs —
          // which would also leave `connection.json` behind. Every run is already
          // stopped by now, so dropping the sockets loses nothing.
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
        await rm(connectionPath, { force: true }).catch(() => {});
        await releaseLock().catch((error) => console.error("释放实例锁失败", error));
        process.exit(0);
      })();
    };
    process.on("SIGINT", () => stop());
    process.on("SIGTERM", () => stop());
    // The shell never SIGTERMs us when it is killed outright, so in desktop mode
    // losing the parent is a shutdown signal of its own.
    if (desktop) watchParentExit({ getPpid: () => process.ppid, onOrphaned: () => stop(true) });
  } catch (error) {
    // Anything between taking the lock and handing the process over to `stop` —
    // a port already in use, an unreadable data directory — must not leave the
    // lock behind for the next launch to trip over.
    await releaseLock().catch(() => {});
    throw error;
  }
}

// Only run when executed directly (`node main.js`), not when a test imports
// this module for its pure helpers.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    const described = describeStartupFailure(error);
    if (described == null) throw error;
    console.error(described.message);
    process.exit(described.exitCode);
  }
}
