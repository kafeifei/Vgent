import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { resolveDataDir } from "./paths.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
import { consoleLogger, type ConnectionInfo } from "./types.js";

const DEFAULT_PORT = 7412;
/** Where the Vite dev server serves `apps/web`; printed so a human can just click it. */
const DEV_WEB_URL = "http://localhost:5173";

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const dataDir = resolveDataDir(flagValue(argv, "data-dir"));
  const portRaw = flagValue(argv, "port") ?? process.env.VGENT_PORT;
  const port = portRaw != null ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`端口不合法: ${portRaw}`);

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const { app, shutdown } = createApp({ dataDir, token, log: consoleLogger });
  const connectionPath = join(dataDir, "connection.json");

  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const url = `http://127.0.0.1:${boundPort}`;

  await writeJsonAtomic(
    connectionPath,
    { version: 1, url, token, pid: process.pid, createdAt: new Date().toISOString() } satisfies ConnectionInfo,
    { mode: 0o600 },
  );

  console.log(`vgent server listening on ${url}  (token in ${connectionPath})`);
  console.log(`web: ${DEV_WEB_URL}/#token=${token}`);

  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // Stopping the runs first lets each engine persist its resume state.
      await shutdown().catch((error) => console.error("停止运行中的任务失败", error));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(connectionPath, { force: true }).catch(() => {});
      process.exit(0);
    })();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

await main();
