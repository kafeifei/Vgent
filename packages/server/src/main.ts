import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { resolveDataDir } from "./paths.js";
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
  const webDistRaw = flagValue(argv, "web-dist") ?? process.env.VGENT_WEB_DIST;
  const explicitWebDist = webDistRaw != null && webDistRaw.length > 0 ? resolve(webDistRaw) : undefined;
  const webDist = resolveWebDist(explicitWebDist, defaultWebDist(import.meta.url));
  // The desktop shell drains our stdio into its own log; the token must not land there.
  const desktop = process.env.VGENT_DESKTOP === "1";

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const { app, projects, shutdown } = createApp({
    dataDir,
    token,
    log: consoleLogger,
    ...(webDist != null ? { webDist } : {}),
  });
  const connectionPath = join(dataDir, "connection.json");

  // `--port 0` is the desktop shell's normal case, so the bound port — not the
  // requested one — is what goes into the URL and `connection.json`.
  let server!: ReturnType<typeof serve>;
  const boundPort = await new Promise<number>((resolve_) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => resolve_(info.port));
  });
  const url = `http://127.0.0.1:${boundPort}`;

  await writeJsonAtomic(
    connectionPath,
    { version: 1, url, token, pid: process.pid, createdAt: new Date().toISOString() } satisfies ConnectionInfo,
    { mode: 0o600 },
  );

  console.log(`vgent server listening on ${url}  (token in ${connectionPath})`);
  const webUrl = `${webDist == null ? DEV_WEB_URL : url}/#token=${token}`;
  if (!desktop) console.log(`web: ${webUrl}`);

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
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // Stopping the runs first lets each engine persist its resume state.
      await shutdown().catch((error) => console.error("停止运行中的任务失败", error));
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
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// Only run when executed directly (`node main.js`), not when a test imports
// this module for its pure helpers.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) await main();
