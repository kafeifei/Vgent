import { timingSafeEqual } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS, createUIMessageStreamResponse } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError, VgentServerError } from "./errors.js";
import type { EngineRegistry } from "./engines/registry.js";
import { createEngineRegistry } from "./engines/registry.js";
import { createRunManager, recoverInterruptedThreads } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore, type SettingsPatch } from "./store/settings.js";
import { createThreadStore } from "./store/threads.js";
import type { EngineId, Logger, PermissionMode } from "./types.js";
import { silentLogger } from "./types.js";

export const VGENT_SERVER_VERSION = "0.0.1";

/** Local-only listener: anything but a loopback Host header is a DNS-rebinding attempt. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STATE_DEBOUNCE_MS = 50;
const KEEPALIVE_MS = 15_000;

const ENGINES: readonly EngineId[] = ["claude-code", "codex", "vgent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];

export interface CreateAppOptions {
  dataDir: string;
  token: string;
  registry?: EngineRegistry;
  log?: Logger;
  /** How long a stop waits for a run to wind down before forcing its slot open. Tests shorten it. */
  stopTimeoutMs?: number;
}

export interface VgentApp {
  app: Hono;
  shutdown(): Promise<void>;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function asEngine(value: unknown): EngineId | undefined {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value) ? (value as EngineId) : undefined;
}

function asPermissionMode(value: unknown): PermissionMode | undefined {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : undefined;
}

export function createApp(options: CreateAppOptions): VgentApp {
  const log = options.log ?? silentLogger;
  const { dataDir, token } = options;

  const projects = createProjectStore(dataDir, log);
  const threads = createThreadStore(dataDir, log);
  const settings = createSettingsStore(dataDir, log);
  const registry = options.registry ?? createEngineRegistry();
  const runs = createRunManager({
    threads,
    projects,
    registry,
    dataDir,
    log,
    ...(options.stopTimeoutMs != null ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
  });

  // Nothing on disk can be mid-turn at boot; this process has no runs yet.
  const recovered = recoverInterruptedThreads(threads, log).catch((error) => log.warn("恢复中断线程失败", error));

  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof VgentServerError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    log.error("未处理的服务端错误", error);
    return c.json({ error: { code: "internal_error", message: "服务器内部错误" } }, 500);
  });

  app.use("/api/*", async (c, next) => {
    // `@hono/node-server` builds `c.req.url` from the Host header; a synthetic
    // `Request` (tests, fetch handlers) carries the host only in the URL.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = host.replace(/:\d+$/, "");
    if (!LOOPBACK_HOSTNAMES.has(hostname)) {
      return c.json({ error: { code: "forbidden_host", message: "只接受来自本机的请求" } }, 403);
    }
    if (c.req.path === "/api/health") return next();

    const header = c.req.header("authorization");
    const bearer = header?.toLowerCase().startsWith("bearer ") === true ? header.slice(7) : undefined;
    // EventSource cannot set headers, so the two SSE GETs also take `?token=`.
    const isSse = c.req.method === "GET" && (c.req.path === "/api/state" || c.req.path.endsWith("/stream"));
    const query = isSse ? c.req.query("token") : undefined;
    const provided = bearer ?? c.req.header("x-vgent-token") ?? query;
    if (provided == null || !tokensMatch(provided, token)) throw new UnauthorizedError();
    return next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: VGENT_SERVER_VERSION }));

  // --- projects ---------------------------------------------------------

  app.get("/api/projects", async (c) => c.json({ projects: await projects.list() }));

  app.post("/api/projects", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const repoPath = (body as { repoPath?: unknown } | undefined)?.repoPath;
    if (typeof repoPath !== "string" || repoPath.length === 0) throw new BadRequestError("缺少 repoPath", "invalid_repo_path");
    const name = (body as { name?: unknown }).name;
    return c.json(await projects.create({ repoPath, ...(typeof name === "string" ? { name } : {}) }));
  });

  app.delete("/api/projects/:id", async (c) => {
    await projects.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // --- threads ----------------------------------------------------------

  app.get("/api/threads", async (c) => {
    const projectId = c.req.query("projectId");
    const all = await threads.list();
    return c.json({ threads: projectId == null ? all : all.filter((thread) => thread.projectId === projectId) });
  });

  app.post("/api/threads", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const projectId = body?.projectId;
    if (typeof projectId !== "string") throw new BadRequestError("缺少 projectId", "invalid_project");
    if ((await projects.get(projectId)) == null) throw new NotFoundError(`项目不存在: ${projectId}`, "project_not_found");
    const defaults = await settings.get();
    const model = body?.model ?? defaults.defaultModel;
    const record = await threads.create({
      projectId,
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      engine: asEngine(body?.engine) ?? defaults.defaultEngine,
      ...(typeof model === "string" ? { model } : {}),
      permissionMode: asPermissionMode(body?.permissionMode) ?? defaults.defaultPermissionMode,
    });
    return c.json(record);
  });

  app.get("/api/threads/:id", async (c) => {
    const record = await threads.get(c.req.param("id"));
    if (record == null) throw new NotFoundError(`线程不存在: ${c.req.param("id")}`, "thread_not_found");
    return c.json(record);
  });

  app.patch("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    if (runs.isRunning(id)) throw new ConflictError(`线程正在运行，无法修改: ${id}`, "thread_running");
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const record = await threads.update(id, {
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      ...(asPermissionMode(body?.permissionMode) != null ? { permissionMode: asPermissionMode(body?.permissionMode)! } : {}),
      ...("model" in (body ?? {}) ? { model: typeof body?.model === "string" ? body.model : undefined } : {}),
    });
    return c.json(record);
  });

  app.delete("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    await runs.stop(id);
    await threads.remove(id);
    return c.body(null, 204);
  });

  // --- settings ---------------------------------------------------------

  app.get("/api/settings", async (c) => c.json(await settings.get()));

  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const patch: SettingsPatch = {
      ...(asEngine(body?.defaultEngine) != null ? { defaultEngine: asEngine(body?.defaultEngine)! } : {}),
      ...(asPermissionMode(body?.defaultPermissionMode) != null
        ? { defaultPermissionMode: asPermissionMode(body?.defaultPermissionMode)! }
        : {}),
      ...("defaultModel" in (body ?? {}) ? { defaultModel: typeof body?.defaultModel === "string" ? body.defaultModel : undefined } : {}),
    };
    return c.json(await settings.update(patch));
  });

  // --- chat -------------------------------------------------------------

  app.post("/api/chat/:threadId", async (c) => {
    await recovered;
    const threadId = c.req.param("threadId");
    const body = (await c.req.json().catch(() => undefined)) as { messages?: unknown } | undefined;
    if (body?.messages == null) throw new BadRequestError("缺少 messages", "invalid_messages");
    const hub = await runs.start(threadId, body.messages);
    return createUIMessageStreamResponse({
      stream: hub.subscribe(c.req.raw.signal),
      headers: UI_MESSAGE_STREAM_HEADERS,
    });
  });

  app.get("/api/chat/:threadId/stream", (c) => {
    const stream = runs.subscribe(c.req.param("threadId"), c.req.raw.signal);
    if (stream == null) return c.body(null, 204);
    return createUIMessageStreamResponse({ stream, headers: UI_MESSAGE_STREAM_HEADERS });
  });

  app.post("/api/chat/:threadId/stop", async (c) => {
    await runs.stop(c.req.param("threadId"));
    return c.body(null, 204);
  });

  // --- state SSE --------------------------------------------------------

  type StateClient = { send(payload: string): void };
  const clients = new Set<StateClient>();
  let debounce: NodeJS.Timeout | undefined;

  const buildState = async () =>
    JSON.stringify({
      projects: await projects.list(),
      threads: await threads.list(),
      settings: await settings.get(),
    });

  const broadcast = () => {
    if (debounce != null || clients.size === 0) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      // One serialization shared by every client; no per-client cloning.
      void buildState()
        .then((payload) => {
          for (const client of [...clients]) client.send(payload);
        })
        .catch((error) => log.warn("广播状态失败", error));
    }, STATE_DEBOUNCE_MS);
    debounce.unref?.();
  };

  const unsubscribes = [projects.subscribe(broadcast), threads.subscribe(broadcast), settings.subscribe(broadcast)];

  app.get("/api/state", (c) =>
    streamSSE(c, async (stream) => {
      await recovered;
      let closed = false;
      const client: StateClient = {
        send: (payload) => {
          if (closed) return;
          void stream.writeSSE({ event: "state", data: payload }).catch(() => {});
        },
      };
      clients.add(client);
      const keepalive = setInterval(() => {
        if (!closed) void stream.write(": keepalive\n\n").catch(() => {});
      }, KEEPALIVE_MS);
      keepalive.unref?.();

      await stream.writeSSE({ event: "state", data: await buildState() });

      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
      closed = true;
      clearInterval(keepalive);
      clients.delete(client);
    }),
  );

  return {
    app,
    async shutdown() {
      if (debounce != null) clearTimeout(debounce);
      for (const unsubscribe of unsubscribes) unsubscribe();
      clients.clear();
      await runs.stopAll();
    },
  };
}
