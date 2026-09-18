import { timingSafeEqual } from "node:crypto";
import { resolveModel } from "@vgent/engine";
import { UI_MESSAGE_STREAM_HEADERS, createUIMessageStreamResponse, type LanguageModel } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { compactThread } from "./compact.js";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError, UpstreamModelError, VgentServerError } from "./errors.js";
import type { EngineRegistry } from "./engines/registry.js";
import { createEngineRegistry, engineDescriptors, engineIds } from "./engines/registry.js";
import { DEFAULT_VGENT_MODEL } from "./engines/vgent.js";
import type { Files } from "./files.js";
import { createFiles } from "./files.js";
import type { Git } from "./git.js";
import { createGit } from "./git.js";
import { pickFile, pickFolder } from "./folder-picker.js";
import { asIntegrateAction, changeStatsOf, createIntegrator, taskTarget, type Integrator, type TaskTarget } from "./integrate.js";
import { createModelCatalog } from "./models.js";
import { createRunManager, recoverInterruptedThreads } from "./runs.js";
import { registerStatic } from "./static.js";
import { createProjectStore, type ProjectStore } from "./store/projects.js";
import { asMcpServers, createSettingsStore, type SettingsPatch } from "./store/settings.js";
import { createThreadStore, type ThreadPatch } from "./store/threads.js";
import type { ChangeStats, EngineId, Logger, PermissionMode, Project, ThreadRecord, ThreadWorkspace } from "./types.js";
import { silentLogger } from "./types.js";
import { createWorktree, reclaimWorktree, removeWorktree, restoreWorktree } from "./workspace.js";
import { DEFAULT_WORKTREE_MAX_COUNT, enforceWorktreeLimit } from "./worktree-limit.js";
import { failInterruptedSetups, readSetupLog, startSetup } from "./worktree-setup.js";

export const VGENT_SERVER_VERSION = "0.0.1";

/** Local-only listener: anything but a loopback Host header is a DNS-rebinding attempt. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const isLoopbackHostname = (hostname: string): boolean => LOOPBACK_HOSTNAMES.has(hostname);
const STATE_DEBOUNCE_MS = 50;
const KEEPALIVE_MS = 15_000;

const PERMISSION_MODES: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];

export interface CreateAppOptions {
  dataDir: string;
  token: string;
  registry?: EngineRegistry;
  /** The `git diff` backend behind the changes routes. Tests inject a shorter-fused one. */
  git?: Git;
  /** The 收口 backend. Tests inject one whose `gh` / `git push` are fakes. */
  integrator?: Integrator;
  /** The working-tree listing backend behind the files routes. */
  files?: Files;
  log?: Logger;
  /** A built `apps/web` to serve at `/`; unset leaves the server API-only. */
  webDist?: string;
  /** How long a stop waits for a run to wind down before forcing its slot open. Tests shorten it. */
  stopTimeoutMs?: number;
  /** The summariser behind `POST /threads/:id/compact`. Unset, the thread's own model is resolved. */
  compactModel?: LanguageModel;
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

function asPermissionMode(value: unknown): PermissionMode | undefined {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : undefined;
}

/**
 * A thread's「思考等级」, as a request body spells it. Kept as an opaque string
 * because each engine names its own levels — the model catalog is what tells
 * the client which ones are on offer — so this only rejects what could never be
 * one: a non-string, blank, or absurdly long value. `null` means「清掉」and is
 * the caller's business, so it passes straight through.
 */
const MAX_REASONING_EFFORT_LEN = 32;

function readReasoningEffort(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_REASONING_EFFORT_LEN) {
    throw new BadRequestError("reasoningEffort 必须是非空短字符串", "invalid_reasoning_effort");
  }
  return trimmed;
}

const PICK_KINDS = ["folder", "file"] as const;
type PickKind = (typeof PICK_KINDS)[number];

/** Defaults to `"folder"`, the route's original (and only) behaviour. */
function asPickKind(value: unknown): PickKind {
  if (value === undefined) return "folder";
  if (typeof value === "string" && (PICK_KINDS as readonly string[]).includes(value)) return value as PickKind;
  throw new BadRequestError('kind 只能是 "folder" 或 "file"', "invalid_pick_kind");
}

/** One tool name for the global allowlist, from a request body or a URL segment. */
function readToolName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name === "") throw new BadRequestError("tool 必须是非空字符串", "invalid_tool");
  return name;
}

/** The whole global allowlist from a settings body: non-empty names, deduped. */
function readAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || name.trim() === "")) {
    throw new BadRequestError("allowlist 只能是非空字符串的数组", "invalid_allowlist");
  }
  return [...new Set((value as string[]).map((name) => name.trim()))];
}

/** The worktree cap from a settings body. `null` restores the built-in default. */
function readWorktreeMaxCount(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new BadRequestError("worktreeMaxCount 必须是不小于 1 的整数", "invalid_worktree_max_count");
  }
  return value;
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
  const files = options.files ?? createFiles();
  const integrator = options.integrator ?? createIntegrator();

  // The registry is the one list of engines: what exists, what it is called,
  // and what it can do. Nothing below spells an engine id out.
  const ids = engineIds(registry);
  const asEngine = (value: unknown): EngineId | undefined =>
    typeof value === "string" && (ids as readonly string[]).includes(value) ? (value as EngineId) : undefined;
  const capabilitiesOf = (engine: EngineId) => registry[engine].descriptor.capabilities;

  /**
   * 「+N −M」 for one task, against its baseline. Undefined — never an error —
   * whenever there is nothing to measure: a reclaimed worktree, a project that
   * vanished, a directory that is not a repo.
   */
  const changeStatsFor = async (thread: ThreadRecord): Promise<ChangeStats | undefined> => {
    if (thread.workspace?.reclaimed === true) return undefined;
    const project = await projects.get(thread.projectId);
    if (project == null) return undefined;
    const target = taskTarget(thread, project);
    return changeStatsOf(await git.changes(target.repoPath, target.baseCommit));
  };

  const runs = createRunManager({
    threads,
    projects,
    settings,
    registry,
    dataDir,
    log,
    changeStats: changeStatsFor,
    ...(options.stopTimeoutMs != null ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
  });

  /** `settings.worktreeMaxCount`, defaulted. */
  const worktreeCap = async (): Promise<number> => (await settings.get()).worktreeMaxCount ?? DEFAULT_WORKTREE_MAX_COUNT;
  const trimWorktrees = (): Promise<void> =>
    worktreeCap()
      .then((max) => enforceWorktreeLimit({ dataDir, threads, projects, max, log }))
      .then(() => {})
      .catch((error: unknown) => log.warn("回收超额 worktree 失败", error));

  // Nothing on disk can be mid-turn at boot; this process has no runs yet — and
  // a setup that was `running` died with the process that owned it.
  const recovered = recoverInterruptedThreads(threads, registry, log)
    .then(() => failInterruptedSetups(threads, log))
    .catch((error) => log.warn("恢复中断线程失败", error));
  /**
   * Tasks whose last turn ended before 收口 existed carry no `changeStats`, so
   * one with real un-integrated work sits in 已完成 instead of 待验收. Counted
   * once, after the trim — a task whose directory that just reclaimed has
   * nothing left to count. A path that is gone is skipped without a word.
   */
  const backfillChangeStats = async (): Promise<void> => {
    for (const summary of await threads.list()) {
      if (summary.changeStats != null || summary.archivedAt != null || summary.workspace?.reclaimed === true) continue;
      const thread = await threads.get(summary.id);
      if (thread == null || thread.changeStats != null || isLive(thread)) continue;
      const stats = await changeStatsFor(thread).catch(() => undefined);
      if (stats != null) await threads.update(thread.id, { changeStats: stats });
    }
  };

  // Detached: trimming snapshots directories and the backfill shells out to
  // git once per task, and the first `/api/state` waits on `recovered` — it
  // must not also wait on housekeeping.
  void recovered
    .then(trimWorktrees)
    .then(backfillChangeStats)
    .catch((error: unknown) => log.warn("补算改动统计失败", error));

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

  /**
   * The two directories and the baseline this task's diff is measured against:
   * its own worktree from `workspace.baseCommit`, or the project from HEAD.
   */
  const targetFor = async (thread: ThreadRecord): Promise<TaskTarget> => {
    if (thread.workspace?.reclaimed === true) throw new ConflictError("此任务的工作目录已回收", "workspace_reclaimed");
    return taskTarget(thread, await projectOf(thread));
  };

  const targetOf = async (threadId: string): Promise<TaskTarget> => targetFor(await threadOf(threadId));

  /**
   * A turn that is parked on an approval or a question has no run entry, but its
   * engine is still alive and still owns the working tree — 收口 or 归档
   * underneath it would pull the files out from under a live step.
   */
  const isLive = (thread: ThreadRecord): boolean =>
    runs.isRunning(thread.id) || thread.status === "awaiting-approval" || thread.status === "awaiting-input";

  const assertNotLive = (thread: ThreadRecord): void => {
    if (isLive(thread)) throw new ConflictError("任务还在进行中（等待审批或回答），先处理或停止", "thread_running");
  };

  /** Keeps the record's 「+N −M」 current after an action that changed the tree. */
  const restat = async (threadId: string): Promise<void> => {
    const thread = await threads.get(threadId);
    if (thread == null) return;
    const stats = await changeStatsFor(thread).catch((error: unknown) => {
      log.warn(`统计线程 ${threadId} 的改动失败`, error);
      return undefined;
    });
    if (stats != null) await threads.update(threadId, { changeStats: stats });
  };

  app.get("/api/threads/:id/changes", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    const target = await targetFor(thread);
    const snapshot = await git.changes(target.repoPath, target.baseCommit);
    // The user can commit, edit or `git checkout` outside Vgent, which leaves
    // the record's 「+N −M」 — and with it the 待验收 bucket — describing a tree
    // that no longer exists. This panel just counted the real one, for free.
    if (!isLive(thread)) {
      const stats = changeStatsOf(snapshot);
      const stored = thread.changeStats;
      if (stored?.files !== stats.files || stored.additions !== stats.additions || stored.deletions !== stats.deletions) {
        await threads.update(thread.id, { changeStats: stats });
      }
    }
    return c.json(snapshot);
  });

  app.get("/api/threads/:id/changes/file", async (c) => {
    const target = await targetOf(c.req.param("id"));
    const path = c.req.query("path");
    if (path == null || path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    return c.json(await git.fileDiff(target.repoPath, path, target.baseCommit));
  });

  app.post("/api/threads/:id/changes/revert", async (c) => {
    const id = c.req.param("id");
    const target = await targetOf(id);
    const body = (await c.req.json().catch(() => undefined)) as { path?: unknown } | undefined;
    if (typeof body?.path !== "string" || body.path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    const result = await git.revert(target.repoPath, body.path, target.baseCommit);
    await restat(id);
    return c.json(result);
  });

  // --- 收口 -------------------------------------------------------------

  app.get("/api/threads/:id/integration", async (c) => c.json(await integrator.status(await targetOf(c.req.param("id")))));

  app.post("/api/threads/:id/integrate", async (c) => {
    const id = c.req.param("id");
    const thread = await threadOf(id);
    assertNotLive(thread);
    const target = await targetFor(thread);
    const body = (await c.req.json().catch(() => undefined)) as { action?: unknown; message?: unknown } | undefined;
    const action = asIntegrateAction(body?.action);
    const outcome = await integrator.integrate(target, {
      action,
      ...(typeof body?.message === "string" ? { message: body.message } : {}),
    });
    const updated = await threads.update(id, { outcome });
    await restat(id);
    return c.json((await threads.get(id)) ?? updated);
  });

  // --- files ------------------------------------------------------------

  app.get("/api/threads/:id/files", async (c) => {
    const { repoPath: root } = await targetOf(c.req.param("id"));
    const q = c.req.query("q");
    const limit = c.req.query("limit");
    return c.json(
      await files.list(root, {
        ...(q != null ? { q } : {}),
        ...(limit != null ? { limit: Number.parseInt(limit, 10) } : {}),
      }),
    );
  });

  app.get("/api/threads/:id/files/content", async (c) => {
    const { repoPath: root } = await targetOf(c.req.param("id"));
    const path = c.req.query("path");
    if (path == null || path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    return c.json(await files.content(root, path));
  });

  // --- workspace --------------------------------------------------------

  /**
   * Snapshot and remove the task's worktree. `undefined` means there was
   * nothing to do — no worktree, or it is already gone — so the caller leaves
   * the record alone. Archiving shares this with the explicit route.
   */
  const reclaimFor = async (thread: ThreadRecord): Promise<ThreadWorkspace | undefined> => {
    const workspace = thread.workspace;
    if (workspace == null || workspace.reclaimed === true) return undefined;
    const { snapshotPath } = await reclaimWorktree({ dataDir, project: await projectOf(thread), thread });
    return { ...workspace, reclaimed: true, snapshotPath };
  };

  /** The other direction; `undefined` when the task's directory is already there. */
  const restoreFor = async (thread: ThreadRecord): Promise<ThreadWorkspace | undefined> => {
    const workspace = thread.workspace;
    if (workspace?.reclaimed !== true || workspace.snapshotPath == null) return undefined;
    const { branch } = await restoreWorktree({
      dataDir,
      project: await projectOf(thread),
      thread,
      snapshotPath: workspace.snapshotPath,
    });
    // The snapshot carried the ignored files back too (`node_modules` included),
    // so setup is not re-run and its old result stays on the record.
    return {
      mode: "worktree",
      path: workspace.path,
      branch,
      baseCommit: workspace.baseCommit,
      ...(workspace.setup != null ? { setup: workspace.setup } : {}),
    };
  };

  app.post("/api/threads/:id/workspace/reclaim", async (c) => {
    const id = c.req.param("id");
    if (runs.isRunning(id)) throw new ConflictError(`线程正在运行，无法回收工作目录: ${id}`, "thread_running");
    const thread = await threadOf(id);
    if (thread.workspace == null) throw new ConflictError("此任务没有独立工作目录", "workspace_not_worktree");
    const workspace = await reclaimFor(thread);
    return c.json(workspace == null ? thread : await threads.update(id, { workspace }));
  });

  // What the project's setup script printed. The 终端 tab shows it as the
  // task's first entry, so it is fetched rather than pushed through messages.
  app.get("/api/threads/:id/workspace/setup-log", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    const setup = thread.workspace?.setup;
    return c.json({
      status: setup?.status ?? "none",
      ...(setup?.exitCode != null ? { exitCode: setup.exitCode } : {}),
      log: await readSetupLog(dataDir, thread.id),
    });
  });

  app.post("/api/threads/:id/workspace/restore", async (c) => {
    const id = c.req.param("id");
    const workspace = await restoreFor(await threadOf(id));
    if (workspace == null) throw new ConflictError("此任务的工作目录没有被回收，无需恢复", "workspace_not_reclaimed");
    return c.json(await threads.update(id, { workspace }));
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
    const engine = asEngine(body?.engine) ?? defaults.defaultEngine;
    // `defaultModel` belongs to `defaultEngine`; another engine would not know
    // that id, so it starts on its own default instead.
    const model = body?.model ?? (engine === defaults.defaultEngine ? defaults.defaultModel : undefined);
    const reasoningEffort = readReasoningEffort(body?.reasoningEffort);
    // `permissionMode` is no longer a thread field — 运行模式 is global — but an
    // older client may still send it; ignoring it is kinder than a 400.
    const record = await threads.create({
      projectId,
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      engine,
      ...(typeof model === "string" ? { model } : {}),
      ...(reasoningEffort != null ? { reasoningEffort } : {}),
    });
    if (body?.workspace !== "worktree") return c.json(record);
    // The worktree is named after the thread, so the record has to exist
    // first — and must not survive a worktree that failed to materialize.
    try {
      const workspace = await createWorktree({ dataDir, project, threadId: record.id });
      const withWorkspace = await threads.update(record.id, { workspace });
      // Detached: a `pnpm install` must not hold up the response, and the first
      // message can be typed while it runs — `runs.start()` waits for it.
      startSetup({
        dataDir,
        threadId: record.id,
        workspacePath: workspace.path,
        projectPath: project.repoPath,
        log,
        onStatus: async (setup) => {
          const current = await threads.get(record.id);
          if (current?.workspace == null) return;
          await threads.update(record.id, { workspace: { ...current.workspace, setup } });
        },
      });
      void trimWorktrees();
      return c.json(withWorkspace);
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
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (runs.isRunning(id)) throw new ConflictError(`线程正在运行，无法修改: ${id}`, "thread_running");
    const current = await threads.get(id);
    if (current == null) throw new NotFoundError(`线程不存在: ${id}`, "thread_not_found");

    // `engine` and `model` travel together: picking another engine's model on an
    // empty thread is one edit, not two.
    const engine = asEngine(body?.engine);
    // Switching engines mid-conversation would hand a history the new runtime
    // never produced to a session that cannot resume it. An empty thread has
    // nothing to carry over, so it is free to change.
    if (engine != null && engine !== current.engine && current.messages.length > 0) {
      throw new ConflictError("已有对话的任务不能换引擎，请新建任务", "engine_locked");
    }

    // 归档 is a lifecycle move, not a field edit: it reclaims the task's
    // worktree on the way in and restores it on the way out, and a failure
    // there fails the whole request rather than leaving the two out of step.
    const lifecycle: ThreadPatch = {};
    if ("archived" in (body ?? {})) {
      if (typeof body?.archived !== "boolean") throw new BadRequestError("archived 只能是布尔值", "invalid_archived");
      // Archiving reclaims the worktree, so it needs the same guard 收口 does.
      assertNotLive(current);
      if (body.archived) {
        if (current.archivedAt == null) {
          const workspace = await reclaimFor(current);
          if (workspace != null) lifecycle.workspace = workspace;
          lifecycle.archivedAt = new Date().toISOString();
        }
      } else {
        const workspace = await restoreFor(current);
        if (workspace != null) lifecycle.workspace = workspace;
        lifecycle.archivedAt = undefined;
      }
    }

    const record = await threads.update(id, {
      ...lifecycle,
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      ...(engine != null ? { engine } : {}),
      ...("model" in (body ?? {}) ? { model: typeof body?.model === "string" ? body.model : undefined } : {}),
      // `null` clears it; an absent key leaves it alone.
      ...("reasoningEffort" in (body ?? {}) ? { reasoningEffort: readReasoningEffort(body?.reasoningEffort) } : {}),
    });
    return c.json(record);
  });

  /**
   * 手动 /compact：把整段历史换成一条摘要。Only the in-house engine can take
   * it — the harness engines keep their own transcript on disk, so rewriting
   * the stored messages would desynchronise the two.
   */
  app.post("/api/threads/:id/compact", async (c) => {
    const id = c.req.param("id");
    if (runs.isRunning(id)) throw new ConflictError("任务运行中，等它结束再压缩", "thread_running");
    const thread = await threadOf(id);
    if (!capabilitiesOf(thread.engine).compact) throw new BadRequestError("这个引擎不支持压缩上下文", "compact_unsupported");
    if (thread.status === "awaiting-approval" || thread.status === "awaiting-input") {
      throw new ConflictError("有待处理的审批或提问，先处理完再压缩", "compact_pending");
    }
    if (thread.messages.length < 2) throw new BadRequestError("没有可压缩的对话", "compact_empty");

    const model = options.compactModel ?? resolveModel(thread.model ?? DEFAULT_VGENT_MODEL);
    const { messages } = await compactThread({ thread, model }).catch((error: unknown) => {
      throw new UpstreamModelError(`压缩失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Snapshot the pre-compact history before it's overwritten; if that fails,
    // abort rather than discard messages nothing kept a copy of.
    await threads.snapshotBeforeCompact(id, thread.messages).catch((error: unknown) => {
      throw new VgentServerError({ message: `压缩快照失败: ${error instanceof Error ? error.message : String(error)}`, status: 500, code: "snapshot_failed" });
    });
    return c.json(await threads.update(id, { messages }));
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
      ...(asPermissionMode(body?.runMode) != null ? { runMode: asPermissionMode(body?.runMode)! } : {}),
      ...("allowlist" in (body ?? {}) ? { allowlist: readAllowlist(body?.allowlist) } : {}),
      ...("defaultModel" in (body ?? {}) ? { defaultModel: typeof body?.defaultModel === "string" ? body.defaultModel : undefined } : {}),
      // Unlike the scalars above, a malformed server list is rejected rather
      // than dropped: silently ignoring it would look exactly like an MCP
      // server whose tools never showed up.
      ...("mcpServers" in (body ?? {}) ? { mcpServers: readMcpServers(body?.mcpServers) } : {}),
      ...("worktreeMaxCount" in (body ?? {}) ? { worktreeMaxCount: readWorktreeMaxCount(body?.worktreeMaxCount) } : {}),
    };
    return c.json(await settings.update(patch));
  });

  // 「一直允许」 on an approval card, and the 撤销 next to it in 设置. One tool at
  // a time, because that is how the two buttons think about it.
  app.post("/api/settings/allowlist", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { tool?: unknown } | undefined;
    const tool = readToolName(body?.tool);
    const current = (await settings.get()).allowlist;
    if (current.includes(tool)) return c.json(await settings.get());
    return c.json(await settings.update({ allowlist: [...current, tool] }));
  });

  app.delete("/api/settings/allowlist/:tool", async (c) => {
    const tool = readToolName(decodeURIComponent(c.req.param("tool")));
    const current = (await settings.get()).allowlist;
    return c.json(await settings.update({ allowlist: current.filter((name) => name !== tool) }));
  });

  // --- engines ----------------------------------------------------------

  // 引擎能力表. The client shows what an engine can do from this and never
  // branches on its name.
  app.get("/api/engines", (c) => c.json({ engines: engineDescriptors(registry) }));

  // --- model catalog ----------------------------------------------------

  const modelCatalog = createModelCatalog({ log });

  app.get("/api/engines/:engine/models", async (c) => {
    const raw = c.req.param("engine");
    const engine = asEngine(raw);
    if (engine == null) throw new BadRequestError(`未知引擎: ${JSON.stringify(raw)}`, "unknown_engine");
    const catalog = await modelCatalog.list(engine, { refresh: c.req.query("refresh") === "1" });
    // The list is cached per engine; the effective default is a setting, so it
    // is merged in per request instead of baked into the cached catalog. A model
    // id means something to exactly one engine, so `defaultModel` only answers
    // for the engine it was picked under; the others fall back to what we know
    // of their own default — see `DEFAULT_VGENT_MODEL`.
    const current = await settings.get();
    const defaultModel =
      (engine === current.defaultEngine ? current.defaultModel : undefined) ??
      (capabilitiesOf(engine).knownDefaultModel ? DEFAULT_VGENT_MODEL : undefined);
    return c.json({ ...catalog, ...(defaultModel != null ? { defaultModel } : {}) });
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
