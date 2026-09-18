import { timingSafeEqual } from "node:crypto";
import { UI_MESSAGE_STREAM_HEADERS, createUIMessageStreamResponse } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError, VgentServerError } from "./errors.js";
import type { EngineRegistry } from "./engines/registry.js";
import { createEngineRegistry } from "./engines/registry.js";
import type { Git } from "./git.js";
import { createGit } from "./git.js";
import { pickFile, pickFolder } from "./folder-picker.js";
import { createModelCatalog } from "./models.js";
import { createRunManager, recoverInterruptedThreads } from "./runs.js";
import { registerStatic } from "./static.js";
import { createProjectStore, type ProjectStore } from "./store/projects.js";
import { asMcpServers, createSettingsStore, type SettingsPatch } from "./store/settings.js";
import { createThreadStore } from "./store/threads.js";
import type { EngineId, Logger, PermissionMode, Project, ThreadRecord, ThreadWorkspace } from "./types.js";
import { silentLogger } from "./types.js";
import { createWorktree, reclaimWorktree, removeWorktree, restoreWorktree } from "./workspace.js";

export const VGENT_SERVER_VERSION = "0.0.1";

/** Local-only listener: anything but a loopback Host header is a DNS-rebinding attempt. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isLoopbackHostname = (hostname: string): boolean => LOOPBACK_HOSTNAMES.has(hostname);
const STATE_DEBOUNCE_MS = 50;
const KEEPALIVE_MS = 15_000;

const ENGINES: readonly EngineId[] = ["claude-code", "codex", "vgent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];

export interface CreateAppOptions {
  dataDir: string;
  token: string;
  registry?: EngineRegistry;
  /** The `git diff` backend behind the changes routes. Tests inject a shorter-fused one. */
  git?: Git;
  log?: Logger;
  /** A built `apps/web` to serve at `/`; unset leaves the server API-only. */
  webDist?: string;
  /** How long a stop waits for a run to wind down before forcing its slot open. Tests shorten it. */
  stopTimeoutMs?: number;
}

export interface VgentApp {
  app: Hono;
  /** Exposed so `main.ts` can auto-register the caller's repo at startup without a second store. */
  projects: ProjectStore;
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

/**
 * The Codex harness has no built-in tool approval, so `HarnessAgent` refuses to
 * be constructed in any other mode. Rejecting the combination when the thread is
 * written keeps a thread that can never run from existing in the first place.
 */
function assertEngineSupportsMode(engine: EngineId, permissionMode: PermissionMode): void {
  if (engine === "codex" && permissionMode !== "allow-all") {
    throw new BadRequestError("Codex 引擎没有内建工具审批，只支持 allow-all 权限模式", "codex_permission_mode");
  }
}

const PICK_KINDS = ["folder", "file"] as const;
type PickKind = (typeof PICK_KINDS)[number];

/** Defaults to `"folder"`, the route's original (and only) behaviour. */
function asPickKind(value: unknown): PickKind {
  if (value === undefined) return "folder";
  if (typeof value === "string" && (PICK_KINDS as readonly string[]).includes(value)) return value as PickKind;
  throw new BadRequestError('kind 只能是 "folder" 或 "file"', "invalid_pick_kind");
}

/** `mcpServers` from a request body, as a 400 instead of an exception. */
function readMcpServers(value: unknown) {
  try {
    return asMcpServers(value);
  } catch (error) {
    throw new BadRequestError(`mcpServers 不合法: ${error instanceof Error ? error.message : String(error)}`, "invalid_mcp_servers");
  }
}

export function createApp(options: CreateAppOptions): VgentApp {
  const log = options.log ?? silentLogger;
  const { dataDir, token } = options;

  const projects = createProjectStore(dataDir, log);
  const threads = createThreadStore(dataDir, log);
  const settings = createSettingsStore(dataDir, log);
  const registry = options.registry ?? createEngineRegistry();
  const git = options.git ?? createGit();
  const runs = createRunManager({
    threads,
    projects,
    registry,
    dataDir,
    log,
    ...(options.stopTimeoutMs != null ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
  });

  // Nothing on disk can be mid-turn at boot; this process has no runs yet.
  const recovered = recoverInterruptedThreads(threads, registry, log).catch((error) => log.warn("恢复中断线程失败", error));

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
    if (!isLoopbackHostname(hostname)) {
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

  // Adding a repo (or, with `{ kind: "file" }`, an MCP server's executable)
  // should never mean typing a path, so the native chooser runs here: one
  // implementation for the browser and the desktop shell alike.
  app.post("/api/projects/pick", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const kind = asPickKind((body as { kind?: unknown } | undefined)?.kind);
    const path = kind === "file" ? await pickFile() : await pickFolder();
    if (path == null) return c.body(null, 204);
    return c.json({ path });
  });

  app.delete("/api/projects/:id", async (c) => {
    await projects.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // --- changes ----------------------------------------------------------

  const threadOf = async (id: string): Promise<ThreadRecord> => {
    const thread = await threads.get(id);
    if (thread == null) throw new NotFoundError(`线程不存在: ${id}`, "thread_not_found");
    return thread;
  };

  const projectOf = async (thread: ThreadRecord): Promise<Project> => {
    const project = await projects.get(thread.projectId);
    if (project == null) throw new NotFoundError(`项目不存在: ${thread.projectId}`, "project_not_found");
    return project;
  };

  /** The directory this task actually edits: its own worktree, or the project. */
  const repoPathOf = async (threadId: string): Promise<string> => {
    const thread = await threadOf(threadId);
    if (thread.workspace == null) return (await projectOf(thread)).repoPath;
    if (thread.workspace.reclaimed === true) throw new ConflictError("此任务的工作目录已回收", "workspace_reclaimed");
    return thread.workspace.path;
  };

  app.get("/api/threads/:id/changes", async (c) => c.json(await git.changes(await repoPathOf(c.req.param("id")))));

  app.get("/api/threads/:id/changes/file", async (c) => {
    const repoPath = await repoPathOf(c.req.param("id"));
    const path = c.req.query("path");
    if (path == null || path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    return c.json(await git.fileDiff(repoPath, path));
  });

  app.post("/api/threads/:id/changes/revert", async (c) => {
    const repoPath = await repoPathOf(c.req.param("id"));
    const body = (await c.req.json().catch(() => undefined)) as { path?: unknown } | undefined;
    if (typeof body?.path !== "string" || body.path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    return c.json(await git.revert(repoPath, body.path));
  });

  // --- workspace --------------------------------------------------------

  app.post("/api/threads/:id/workspace/reclaim", async (c) => {
    const id = c.req.param("id");
    if (runs.isRunning(id)) throw new ConflictError(`线程正在运行，无法回收工作目录: ${id}`, "thread_running");
    const thread = await threadOf(id);
    if (thread.workspace == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");
    if (thread.workspace.reclaimed === true) return c.json(thread);
    const { snapshotPath } = await reclaimWorktree({ dataDir, project: await projectOf(thread), thread });
    return c.json(await threads.update(id, { workspace: { ...thread.workspace, reclaimed: true, snapshotPath } }));
  });

  app.post("/api/threads/:id/workspace/restore", async (c) => {
    const id = c.req.param("id");
    const thread = await threadOf(id);
    const workspace = thread.workspace;
    if (workspace?.reclaimed !== true || workspace.snapshotPath == null) {
      throw new ConflictError("此任务的工作目录没有被回收，无需恢复", "workspace_not_reclaimed");
    }
    const { branch } = await restoreWorktree({
      dataDir,
      project: await projectOf(thread),
      thread,
      snapshotPath: workspace.snapshotPath,
    });
    const restored: ThreadWorkspace = { mode: "worktree", path: workspace.path, branch, baseCommit: workspace.baseCommit };
    return c.json(await threads.update(id, { workspace: restored }));
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
    const project = await projects.get(projectId);
    if (project == null) throw new NotFoundError(`项目不存在: ${projectId}`, "project_not_found");
    if (body?.workspace != null && body.workspace !== "project" && body.workspace !== "worktree") {
      throw new BadRequestError("workspace 只能是 project 或 worktree", "invalid_workspace");
    }
    const defaults = await settings.get();
    const model = body?.model ?? defaults.defaultModel;
    const engine = asEngine(body?.engine) ?? defaults.defaultEngine;
    const permissionMode = asPermissionMode(body?.permissionMode) ?? defaults.defaultPermissionMode;
    assertEngineSupportsMode(engine, permissionMode);
    const record = await threads.create({
      projectId,
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      engine,
      ...(typeof model === "string" ? { model } : {}),
      permissionMode,
    });
    if (body?.workspace !== "worktree") return c.json(record);
    // The worktree is named after the thread, so the record has to exist
    // first — and must not survive a worktree that failed to materialize.
    try {
      const workspace = await createWorktree({ dataDir, project, threadId: record.id });
      return c.json(await threads.update(record.id, { workspace }));
    } catch (error) {
      await threads.remove(record.id).catch((failure) => log.warn(`回滚线程 ${record.id} 失败`, failure));
      throw error;
    }
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
    const current = await threads.get(id);
    if (current == null) throw new NotFoundError(`线程不存在: ${id}`, "thread_not_found");

    const engine = asEngine(body?.engine);
    // Switching engines mid-conversation would hand a history the new runtime
    // never produced to a session that cannot resume it. An empty thread has
    // nothing to carry over, so it is free to change.
    if (engine != null && engine !== current.engine && current.messages.length > 0) {
      throw new ConflictError("已有对话的任务不能换引擎，请新建任务", "engine_locked");
    }
    const permissionMode = asPermissionMode(body?.permissionMode);
    assertEngineSupportsMode(engine ?? current.engine, permissionMode ?? current.permissionMode);

    const record = await threads.update(id, {
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      ...(engine != null ? { engine } : {}),
      ...(permissionMode != null ? { permissionMode } : {}),
      ...("model" in (body ?? {}) ? { model: typeof body?.model === "string" ? body.model : undefined } : {}),
    });
    return c.json(record);
  });

  app.delete("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    await runs.stop(id);
    const thread = await threads.get(id);
    // A failed ownership check aborts the delete: a thread record is the only
    // thing that still points at a worktree, so it outlives a directory we
    // refused to touch.
    if (thread?.workspace != null) await removeWorktree({ dataDir, project: await projectOf(thread), thread });
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
      // Unlike the scalars above, a malformed server list is rejected rather
      // than dropped: silently ignoring it would look exactly like an MCP
      // server whose tools never showed up.
      ...("mcpServers" in (body ?? {}) ? { mcpServers: readMcpServers(body?.mcpServers) } : {}),
    };
    return c.json(await settings.update(patch));
  });

  // --- model catalog ----------------------------------------------------

  const modelCatalog = createModelCatalog({ log });

  app.get("/api/engines/:engine/models", async (c) => {
    const raw = c.req.param("engine");
    const engine = asEngine(raw);
    if (engine == null) throw new BadRequestError(`未知引擎: ${JSON.stringify(raw)}`, "unknown_engine");
    return c.json(await modelCatalog.list(engine, { refresh: c.req.query("refresh") === "1" }));
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

  if (options.webDist != null) registerStatic(app, options.webDist, isLoopbackHostname);

  return {
    app,
    projects,
    async shutdown() {
      if (debounce != null) clearTimeout(debounce);
      for (const unsubscribe of unsubscribes) unsubscribe();
      clients.clear();
      await runs.stopAll();
    },
  };
}
