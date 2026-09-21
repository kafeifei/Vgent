import { rm } from "node:fs/promises";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { resolveModel } from "@vgent/engine";
import {
  ModelDiscoveryError,
  POPULAR_PROVIDER_IDS,
  PROVIDER_PROTOCOLS,
  discoverProviderModels,
  parseProviderInput,
  createModelIndex,
  providerModelSpec,
  redactProvider,
  summarizeCatalogProvider,
  type ProviderInput,
  type ProviderProtocol,
} from "@vgent/providers";
import { UI_MESSAGE_STREAM_HEADERS, createUIMessageStreamResponse, type LanguageModel } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createCheckpoint, deleteCheckpoints, listCheckpointCommits, pinBaseline, restoreCheckpoint } from "./checkpoints.js";
import { compactThread } from "./compact.js";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError, UpstreamModelError, VgentServerError } from "./errors.js";
import type { EngineRegistry } from "./engines/registry.js";
import { createEngineRegistry, engineDescriptors, engineIds } from "./engines/registry.js";
import { DEFAULT_VGENT_MODEL } from "./engines/vgent.js";
import type { Files } from "./files.js";
import { createFiles } from "./files.js";
import { createTickets } from "./tickets.js";
import type { HarnessEngineId, HarnessRuntime } from "./harness-runtime.js";
import { createHarnessRuntime } from "./harness-runtime.js";
import type { ChangesResponse, DiffBase, Git } from "./git.js";
import { createGit } from "./git.js";
import { pickFile, pickFolder } from "./folder-picker.js";
import { isNoProject, projectOfThread, scratchDirOf } from "./no-project.js";
import { planFork } from "./fork.js";
import { asIntegrateAction, changeStatsOf, createIntegrator, taskTarget, type Integrator, type TaskTarget } from "./integrate.js";
import { contextOptionsFor, createModelCatalog, type ModelEntry } from "./models.js";
import { reasoningFor } from "./reasoning.js";
import { SUBSCRIPTION_IDS, createSubscriptionService, markHidden, withHiddenModels, type ClaudeLoginStatus, type SubscriptionId } from "./subscriptions.js";
import { createQueueStore, readQueueText } from "./queue.js";
import { asRestoreTarget, lastTurnPair, planRestore, type RestoreTarget } from "./restore.js";
import { createRunManager, recoverInterruptedThreads } from "./runs.js";
import { registerStatic } from "./static.js";
import { createDraftStore, isDraftKey, MAX_DRAFT_BYTES } from "./store/drafts.js";
import { createPlanStore, MAX_PLAN_BYTES } from "./store/plans.js";
import { createProjectStore, type ProjectStore } from "./store/projects.js";
import { createCatalogStore } from "./store/catalog.js";
import { createProviderStore } from "./store/providers.js";
import { asMcpServers, createSettingsStore, type SettingsPatch } from "./store/settings.js";
import { createThreadStore, type ThreadPatch } from "./store/threads.js";
import type {
  ChangeStats,
  CheckpointPreview,
  CheckpointRestore,
  EngineId,
  Logger,
  PermissionMode,
  Project,
  ThreadMode,
  ThreadRecord,
  ThreadRestorePoint,
  ThreadWorkspace,
  UiDensity,
  UiTheme,
} from "./types.js";
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
  /** What `POST /api/providers/discover` reaches a provider with. Tests answer for the provider. */
  providerFetch?: typeof globalThis.fetch;
  /** What the provider catalog (models.dev) is downloaded with. Tests answer for it, or refuse. */
  catalogFetch?: typeof globalThis.fetch;
  /** Whether Claude is signed in on this machine. Tests answer; production asks the `claude` CLI. */
  probeClaudeLogin?: () => Promise<ClaudeLoginStatus>;
  /**
   * The keeper of Claude Code's and Codex's CLI + SDK. Tests pass a fake; left
   * unset the real one is built, but it only checks and upgrades on its own
   * when `autoUpgradeRuntimes` is set — a test server must never reach for npm.
   */
  harnessRuntime?: HarnessRuntime;
  /** Turns on the background check-and-upgrade loop. `main.ts` sets it; tests do not. */
  autoUpgradeRuntimes?: boolean;
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

/** Same shape and same reasoning as `readReasoningEffort`: the catalog names the ids, this only refuses nonsense. */
function readServiceTier(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_REASONING_EFFORT_LEN) {
    throw new BadRequestError("serviceTier 必须是非空短字符串", "invalid_service_tier");
  }
  return trimmed;
}

/** Tokens. The catalog names the choices; this only refuses what is not a window at all. */
function readContextWindow(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 100_000_000) {
    throw new BadRequestError("contextWindow 必须是 token 数", "invalid_context_window");
  }
  return value;
}

function readReasoningEffort(value: unknown): string | undefined {
  if (value == null) return undefined;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_REASONING_EFFORT_LEN) {
    throw new BadRequestError("reasoningEffort 必须是非空短字符串", "invalid_reasoning_effort");
  }
  return trimmed;
}

/** 模式 from a request body. Absent means「不改」; anything but the two words is a 400. */
function readThreadMode(value: unknown): ThreadMode {
  if (value === "plan" || value === "agent") return value;
  throw new BadRequestError('mode 只能是 "plan" 或 "agent"', "invalid_mode");
}

/** The 草稿 key from a URL segment: a thread id, or `new` for the empty state. */
function readDraftKey(value: unknown): string {
  if (!isDraftKey(value)) throw new BadRequestError("草稿 key 不合法", "invalid_draft_key");
  return value;
}

/** The 草稿 text from a `PUT` body. `""` deletes it, which is how a sent message clears it. */
function readDraftText(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("text 必须是字符串", "invalid_draft");
  if (Buffer.byteLength(value, "utf8") > MAX_DRAFT_BYTES) {
    throw new VgentServerError({ message: `草稿超过 ${MAX_DRAFT_BYTES / 1024} KB`, status: 413, code: "draft_too_large" });
  }
  return value;
}

/** 界面偏好 from a settings body. `null` puts the default back; anything unknown is a 400. */
function readTheme(value: unknown): UiTheme | undefined {
  if (value == null) return undefined;
  if (value !== "dark" && value !== "light") throw new BadRequestError('theme 只能是 "dark" 或 "light"', "invalid_theme");
  return value;
}

function readDensity(value: unknown): UiDensity | undefined {
  if (value == null) return undefined;
  if (value !== "comfortable" && value !== "compact") {
    throw new BadRequestError('density 只能是 "comfortable" 或 "compact"', "invalid_density");
  }
  return value;
}

/** The plan document from a `PUT` body: a string, and not an absurd one. */
function readPlanContent(value: unknown): string {
  if (typeof value !== "string") throw new BadRequestError("content 必须是字符串", "invalid_plan");
  if (Buffer.byteLength(value, "utf8") > MAX_PLAN_BYTES) {
    throw new VgentServerError({ message: `计划文档超过 ${MAX_PLAN_BYTES / 1024} KB`, status: 413, code: "plan_too_large" });
  }
  return value;
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
  const plans = createPlanStore(dataDir, log);
  const drafts = createDraftStore(dataDir, log);
  const settings = createSettingsStore(dataDir, log);
  const providers = createProviderStore(dataDir, log);
  const catalog = createCatalogStore(dataDir, { log, ...(options.catalogFetch != null ? { fetch: options.catalogFetch } : {}) });
  const queue = createQueueStore(threads);
  const registry = options.registry ?? createEngineRegistry();
  const git = options.git ?? createGit();
  const files = options.files ?? createFiles();
  const integrator = options.integrator ?? createIntegrator({ log });

  // The registry is the one list of engines: what exists, what it is called,
  // and what it can do. Nothing below spells an engine id out.
  const ids = engineIds(registry);
  const asEngine = (value: unknown): EngineId | undefined =>
    typeof value === "string" && (ids as readonly string[]).includes(value) ? (value as EngineId) : undefined;
  const capabilitiesOf = (engine: EngineId) => registry[engine].descriptor.capabilities;

  /**
   * 「明说，不装」: an engine that cannot run a read-only turn may not be put in
   * Plan mode at all, whichever half of the pair the request changed.
   */
  const assertModeSupported = (mode: ThreadMode, engine: EngineId): void => {
    if (mode === "plan" && !capabilitiesOf(engine).planMode) {
      throw new BadRequestError(`${registry[engine].descriptor.label} 不支持 Plan 模式`, "plan_unsupported");
    }
  };

  /**
   * 「+N −M」 for one task, against its baseline. Undefined — never an error —
   * whenever there is nothing to measure: a reclaimed worktree, a project that
   * vanished, a directory that is not a repo.
   */
  const changeStatsFor = async (thread: ThreadRecord): Promise<ChangeStats | undefined> => {
    if (thread.workspace?.reclaimed === true) return undefined;
    const project = await projectOfThread(projects, dataDir, thread);
    if (project == null) return undefined;
    const target = taskTarget(thread, project);
    return changeStatsOf(await git.changes(target.repoPath, target.baseline));
  };

  // Declared before the run manager, which reports every turn's outcome to it;
  // it asks the run manager back whether an engine is busy, lazily.
  const LIVE_FOR_RUNTIME: readonly string[] = ["running", "awaiting-approval", "awaiting-input"];
  const harnessRuntime: HarnessRuntime =
    options.harnessRuntime ??
    createHarnessRuntime({
      log,
      isBusy: async (engine) =>
        (await threads.list()).some(
          (thread) => thread.engine === engine && (LIVE_FOR_RUNTIME.includes(thread.status) || runs.isRunning(thread.id)),
        ),
    });

  const runs = createRunManager({
    threads,
    projects,
    settings,
    registry,
    dataDir,
    log,
    changeStats: changeStatsFor,
    savePlan: (threadId, content) => plans.put(threadId, content).then(() => {}),
    onTurnSettled: ({ engine, ok, produced }) => harnessRuntime.reportTurn(engine, { ok, produced }),
    queue,
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

  /**
   * 排队 survives a restart: a task that was idle with messages waiting when
   * the process died picks them up now. A task recovered as `interrupted` does
   * not — its queue stays paused until the user says otherwise, which is
   * exactly what `dispatchQueue` decides for itself from the status.
   */
  const dispatchQueuesAtBoot = async (): Promise<void> => {
    for (const summary of await threads.list()) {
      if (summary.status !== "idle" || summary.archivedAt != null || (summary.queue?.length ?? 0) === 0) continue;
      await runs.dispatchQueue(summary.id).catch((error: unknown) => log.warn(`线程 ${summary.id} 的排队消息没能发出`, error));
    }
  };

  // Detached: trimming snapshots directories and the backfill shells out to
  // git once per task, and the first `/api/state` waits on `recovered` — it
  // must not also wait on housekeeping.
  void recovered
    .then(trimWorktrees)
    .then(backfillChangeStats)
    .then(dispatchQueuesAtBoot)
    .catch((error: unknown) => log.warn("补算改动统计失败", error));

  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof VgentServerError) {
      return c.json(
        { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } },
        error.status as 400,
      );
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
    // A ticket's id is its own secret: see `tickets.ts`.
    if (c.req.method === "GET" && c.req.path.startsWith("/api/tickets/")) return next();

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

  /**
   * 空状态那一行要显示的分支：新任务要么直接改这个检出，要么从它已提交的 HEAD
   * 开出 worktree，两种都从这里出发。已经存在的任务不走这条路——它的分支在
   * `workspace` 或者它自己的变更快照里。
   */
  app.get("/api/projects/:id/branch", async (c) => {
    const id = c.req.param("id");
    const project = await projects.get(id);
    if (project == null) throw new NotFoundError(`项目不存在: ${id}`, "project_not_found");
    return c.json({ repoPath: project.repoPath, branch: await git.branch(project.repoPath) });
  });

  // --- changes ----------------------------------------------------------

  const threadOf = async (id: string): Promise<ThreadRecord> => {
    const thread = await threads.get(id);
    if (thread == null) throw new NotFoundError(`线程不存在: ${id}`, "thread_not_found");
    return thread;
  };

  const projectOf = async (thread: ThreadRecord): Promise<Project> => {
    const project = await projectOfThread(projects, dataDir, thread);
    if (project == null) throw new NotFoundError(`项目不存在: ${thread.projectId}`, "project_not_found");
    return project;
  };

  /**
   * The two directories and the baseline this task's diff is measured against:
   * its own worktree from `workspace.baseCommit`, or the project from the
   * snapshot its first turn started with (`baselineCommit`).
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

  /**
   * 改动的范围: 「全部改动」 is the task against its 任务基线 — the working
   * directory as it stands. 「上一轮」 is the last turn's two snapshots against
   * each other, tree to tree, so it never looks at the working directory at all
   * and has nothing to revert against.
   */
  const scopedBase = (thread: ThreadRecord, target: TaskTarget, scope: string | undefined): DiffBase | undefined => {
    if (scope !== "last-turn") return target.baseline;
    const pair = lastTurnPair(thread.messages);
    if (pair == null) throw new NotFoundError("这个任务还没有可以单独看的上一轮", "last_turn_unavailable");
    return pair;
  };

  app.get("/api/threads/:id/changes", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    const target = await targetFor(thread);
    const scope = c.req.query("scope");
    const snapshot = await git.changes(target.repoPath, scopedBase(thread, target, scope));
    // The user can commit, edit or `git checkout` outside Vgent, which leaves
    // the record's 「+N −M」 — and with it the 待验收 bucket — describing a tree
    // that no longer exists. This panel just counted the real one, for free.
    // Only in the default scope: 「上一轮」 counts something else entirely.
    if (scope !== "last-turn" && !isLive(thread)) {
      const stats = changeStatsOf(snapshot);
      const stored = thread.changeStats;
      if (stored?.files !== stats.files || stored.additions !== stats.additions || stored.deletions !== stats.deletions) {
        await threads.update(thread.id, { changeStats: stats });
      }
    }
    const body: ChangesResponse = { ...snapshot, lastTurn: lastTurnPair(thread.messages) != null };
    return c.json(body);
  });

  app.get("/api/threads/:id/changes/file", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    const target = await targetFor(thread);
    const path = c.req.query("path");
    if (path == null || path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    return c.json(await git.fileDiff(target.repoPath, path, scopedBase(thread, target, c.req.query("scope"))));
  });

  app.post("/api/threads/:id/changes/revert", async (c) => {
    const id = c.req.param("id");
    const target = await targetOf(id);
    const body = (await c.req.json().catch(() => undefined)) as { path?: unknown } | undefined;
    if (typeof body?.path !== "string" || body.path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    const result = await git.revert(target.repoPath, body.path, target.baseline);
    await restat(id);
    return c.json(result);
  });

  // --- 收口 -------------------------------------------------------------

  app.get("/api/threads/:id/integration", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    return c.json(await integrator.status(await targetFor(thread), thread.applyUndo != null ? { applyUndo: thread.applyUndo } : {}));
  });

  app.post("/api/threads/:id/integrate", async (c) => {
    const id = c.req.param("id");
    const thread = await threadOf(id);
    assertNotLive(thread);
    const target = await targetFor(thread);
    const body = (await c.req.json().catch(() => undefined)) as
      | { action?: unknown; message?: unknown; conflicts?: unknown }
      | undefined;
    const action = asIntegrateAction(body?.action);
    const result = await integrator.integrate(target, {
      action,
      threadId: id,
      ...(typeof body?.message === "string" ? { message: body.message } : {}),
      // Anything but the explicit 「带冲突标记合并」 keeps today's behaviour.
      ...(body?.conflicts === "markers" ? { conflicts: "markers" as const } : {}),
      ...(thread.applyUndo != null ? { applyUndo: thread.applyUndo } : {}),
    });
    // 提交 in the user's own checkout leaves their other uncommitted work right
    // where it was, so the 任务基线 moves to the state just after the commit:
    // what the task committed stops counting as its un-integrated 改动, and what
    // is still the user's own goes on not counting at all.
    const moved =
      action === "commit" && target.mode === "project" && thread.baselineCommit != null
        ? await pinBaseline({ repoPath: target.repoPath, threadId: id, log })
        : undefined;
    const updated = await threads.update(id, {
      outcome: result.outcome ?? undefined,
      ...(result.pr != null ? { pr: result.pr } : {}),
      ...(result.applyUndo !== undefined ? { applyUndo: result.applyUndo ?? undefined } : {}),
      ...(moved != null ? { baselineCommit: moved } : {}),
    });
    await restat(id);
    const record = (await threads.get(id)) ?? updated;
    // The record plus what this one action did — a 带回 has a file list to show,
    // and a push to a non-GitHub remote has a sentence to read.
    return c.json({
      ...record,
      ...(result.apply != null ? { apply: result.apply } : {}),
      ...(result.undo != null ? { undo: result.undo } : {}),
      ...(result.note != null ? { note: result.note } : {}),
    });
  });

  // --- checkpoint -------------------------------------------------------

  /**
   * What a restore would move: the target checkpoint, and the files the turns
   * between here and there touched. Both routes below go through it, so the
   * sentence the user confirms and the restore that follows can never disagree.
   */
  const planFor = async (thread: ThreadRecord, repoPath: string, target: RestoreTarget) =>
    planRestore({
      repoPath,
      thread,
      target,
      // An arbitrary sha is never checked out: every commit this can name comes
      // from one of the thread's own checkpoint refs.
      known: new Set(await listCheckpointCommits({ repoPath, threadId: thread.id })),
    });

  /** 确认前先说清楚会动几个文件 — read-only, and the same numbers the restore itself will use. */
  app.get("/api/threads/:id/checkpoints/preview", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    const target = await targetFor(thread);
    const messageId = c.req.query("messageId");
    const plan = await planFor(thread, target.repoPath, c.req.query("latest") === "1" ? { latest: true } : asRestoreTarget({ messageId }));
    const body: CheckpointPreview = { files: plan.files, whole: plan.whole };
    return c.json(body);
  });

  /**
   * 恢复到此处: put the files the task touched back to a checkpoint, and keep
   * what they were before as an undo point. Only the working directory moves —
   * the index, HEAD and the conversation are all left exactly as they are, and
   * every file outside the span is left alone too.
   *
   * The same route moves *forward* again: `messageId` names where the thread
   * should stand, and `latest: true` undoes the restore for good.
   */
  app.post("/api/threads/:id/checkpoints/restore", async (c) => {
    const id = c.req.param("id");
    const thread = await threadOf(id);
    assertNotLive(thread);
    const target = await targetFor(thread);
    const plan = await planFor(thread, target.repoPath, asRestoreTarget(await c.req.json().catch(() => undefined)));

    // Taken first, and required: a restore nobody can undo is not one we offer.
    const undo = await createCheckpoint({ repoPath: target.repoPath, threadId: id, undo: true, log });
    if (undo == null) {
      throw new VgentServerError({ message: "没能保存当前状态，已放弃恢复", status: 500, code: "checkpoint_failed" });
    }
    const moved = await restoreCheckpoint({
      repoPath: target.repoPath,
      commit: plan.commit,
      ...(plan.paths != null ? { paths: plan.paths } : {}),
      log,
    });
    log.info(
      `线程 ${id} 恢复到 ${plan.commit.slice(0, 7)}${plan.whole ? "（整目录）" : `（${plan.files} 个文件）`}：写回 ${moved.written} 个，删除 ${moved.deleted} 个`,
    );
    // 「回到最新」 ends the stretch; anything else records where the thread now
    // stands — keeping the *first* undo snapshot, which is the only 最新 there is.
    const restoredTo: ThreadRestorePoint | undefined =
      plan.at == null
        ? undefined
        : { messageId: plan.at, undoCommit: thread.restoredTo?.undoCommit ?? undo.commit, at: new Date().toISOString() };
    await threads.update(id, { restoredTo });
    await restat(id);
    const stats = (await threads.get(id))?.changeStats;
    const body: CheckpointRestore = {
      restored: plan.commit,
      undo: undo.commit,
      files: moved.written + moved.deleted,
      whole: plan.whole,
      ...(restoredTo != null ? { restoredTo } : {}),
      ...(stats != null ? { changeStats: stats } : {}),
    };
    return c.json(body);
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

  /**
   * The file itself, for the previews that show a picture as a picture. The
   * client fetches it with its token and hands the bytes to an `<img>`; nothing
   * here is ever navigated to, and the headers say so for whoever tries.
   */
  app.get("/api/threads/:id/files/raw", async (c) => {
    const { repoPath: root } = await targetOf(c.req.param("id"));
    const path = c.req.query("path");
    if (path == null || path.length === 0) throw new BadRequestError("缺少 path", "invalid_path");
    const file = await files.bytes(root, path);
    return c.body(new Uint8Array(file.bytes), 200, { "content-type": file.mediaType, ...PICTURE_HEADERS });
  });

  /** What a picture is served with wherever it is served whole: shown, never run, never cached. */
  const PICTURE_HEADERS = {
    "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  const tickets = createTickets();
  /** A drawing that exists only in a reply is small; a file has `files.bytes`' own cap. */
  const MAX_INLINE_SVG_CHARS = 2_000_000;

  /**
   * 「在浏览器打开」: says what `/api/tickets/<ticket>` — an address the client
   * made up and has already opened — should serve. `path` names one of the
   * task's files; `svg` is a drawing that exists only in a reply.
   */
  app.post("/api/threads/:id/files/ticket", async (c) => {
    const { repoPath: root } = await targetOf(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { ticket?: unknown; path?: unknown; svg?: unknown } | null;
    const ticket = typeof body?.ticket === "string" ? body.ticket : "";
    let content: { mediaType: string; bytes: Uint8Array } | undefined;
    if (typeof body?.path === "string" && body.path.length > 0) content = await files.bytes(root, body.path);
    else if (typeof body?.svg === "string" && body.svg.length > 0 && body.svg.length <= MAX_INLINE_SVG_CHARS) {
      content = { mediaType: "image/svg+xml", bytes: new TextEncoder().encode(body.svg) };
    }
    if (content == null) throw new BadRequestError("缺少 path 或 svg", "invalid_path");
    if (!tickets.register(ticket, content)) throw new BadRequestError("ticket 不合格", "invalid_ticket");
    return c.body(null, 204);
  });

  app.get("/api/tickets/:ticket", async (c) => {
    const content = await tickets.read(c.req.param("ticket"));
    if (content == null) throw new NotFoundError("这个地址已经失效，回到 Vgent 再点一次", "ticket_expired");
    return c.body(new Uint8Array(content.bytes), 200, { "content-type": content.mediaType, ...PICTURE_HEADERS });
  });

  /** Which of these paths — as tools and replies wrote them — are files of this task, right now. */
  app.post("/api/threads/:id/files/resolve", async (c) => {
    const { repoPath: root } = await targetOf(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { paths?: unknown } | null;
    const paths = Array.isArray(body?.paths) ? body.paths.filter((entry): entry is string => typeof entry === "string") : null;
    if (paths == null) throw new BadRequestError("缺少 paths", "invalid_path");
    return c.json({ files: await files.resolve(root, paths) });
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
    // 无项目 is not a stored project: the task gets a directory of its own when it first runs.
    const project = isNoProject(projectId) ? undefined : await projects.get(projectId);
    if (project == null && !isNoProject(projectId)) throw new NotFoundError(`项目不存在: ${projectId}`, "project_not_found");
    if (body?.workspace != null && body.workspace !== "project" && body.workspace !== "worktree") {
      throw new BadRequestError("workspace 只能是 project 或 worktree", "invalid_workspace");
    }
    if (project == null && body?.workspace === "worktree") throw new BadRequestError("无项目的任务没有仓库，开不了 worktree", "invalid_workspace");
    const defaults = await settings.get();
    const engine = asEngine(body?.engine) ?? defaults.defaultEngine;
    // `defaultModel` belongs to `defaultEngine`; another engine would not know
    // that id, so it starts on its own default instead.
    const model = body?.model ?? (engine === defaults.defaultEngine ? defaults.defaultModel : undefined);
    const reasoningEffort = readReasoningEffort(body?.reasoningEffort);
    const serviceTier = readServiceTier(body?.serviceTier);
    const contextWindow = readContextWindow(body?.contextWindow);
    const mode = body?.mode === undefined ? "agent" : readThreadMode(body.mode);
    assertModeSupported(mode, engine);
    // `permissionMode` is no longer a thread field — 运行模式 is global — but an
    // older client may still send it; ignoring it is kinder than a 400.
    const record = await threads.create({
      projectId,
      ...(typeof body?.title === "string" ? { title: body.title } : {}),
      engine,
      ...(typeof model === "string" ? { model } : {}),
      ...(reasoningEffort != null ? { reasoningEffort } : {}),
      ...(serviceTier != null ? { serviceTier } : {}),
      ...(contextWindow != null ? { contextWindow } : {}),
      mode,
    });
    if (body?.workspace !== "worktree" || project == null) return c.json(record);
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

  // 分叉: a new task holding this one's conversation up to the end of one of its
  // turns, named by the user message that started it. Same project, same engine and model —
  // and the project directory as its workspace: a fork copies what was said, not
  // a worktree.
  app.post("/api/threads/:id/fork", async (c) => {
    const source = await threads.get(c.req.param("id"));
    if (source == null) throw new NotFoundError(`线程不存在: ${c.req.param("id")}`, "thread_not_found");
    const body = (await c.req.json().catch(() => undefined)) as { messageId?: unknown } | undefined;
    if (typeof body?.messageId !== "string") throw new BadRequestError("缺少 messageId", "invalid_message");
    const messages = planFork(source.messages, body.messageId);
    const thread = await threads.create({
      projectId: source.projectId,
      title: `${source.title}（分叉）`,
      engine: source.engine,
      ...(source.model != null ? { model: source.model } : {}),
      ...(source.reasoningEffort != null ? { reasoningEffort: source.reasoningEffort } : {}),
      ...(source.serviceTier != null ? { serviceTier: source.serviceTier } : {}),
      ...(source.contextWindow != null ? { contextWindow: source.contextWindow } : {}),
      ...(source.mode != null ? { mode: source.mode } : {}),
      messages,
      forkedFrom: { threadId: source.id, messageId: body.messageId, pending: true },
    });
    return c.json(thread, 201);
  });

  app.get("/api/threads/:id", async (c) => {
    const record = await threads.get(c.req.param("id"));
    if (record == null) throw new NotFoundError(`线程不存在: ${c.req.param("id")}`, "thread_not_found");
    return c.json(record);
  });

  app.patch("/api/threads/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const marksRead = "unread" in (body ?? {});
    if (marksRead && typeof body?.unread !== "boolean") throw new BadRequestError("unread 只能是布尔值", "invalid_unread");
    // 未读 is bookkeeping the client writes while it looks at the task, and a
    // turn can start under it (排队) — so an unread-only PATCH is the one edit a
    // running thread still takes. Everything else waits for the turn.
    if (!(marksRead && Object.keys(body ?? {}).length === 1) && runs.isRunning(id)) {
      throw new ConflictError(`线程正在运行，无法修改: ${id}`, "thread_running");
    }
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

    // 模式 decides what the *next* turn does, so it cannot change under a turn
    // that is already running or parked on a question.
    const mode = body?.mode === undefined ? undefined : readThreadMode(body.mode);
    if (mode != null) assertNotLive(current);
    // Either half of「模式 + 引擎」may be the one that breaks the pair.
    assertModeSupported(mode ?? current.mode ?? "agent", engine ?? current.engine);

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
          // 撤销带回 is an offer about a task the user is still looking at.
          // Archiving says they are done with it, so the offer goes away.
          lifecycle.applyUndo = undefined;
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
      ...(mode != null ? { mode } : {}),
      ...(marksRead ? { unread: body?.unread === true } : {}),
      ...("model" in (body ?? {}) ? { model: typeof body?.model === "string" ? body.model : undefined } : {}),
      // `null` clears it; an absent key leaves it alone.
      ...("reasoningEffort" in (body ?? {}) ? { reasoningEffort: readReasoningEffort(body?.reasoningEffort) } : {}),
      ...("serviceTier" in (body ?? {}) ? { serviceTier: readServiceTier(body?.serviceTier) } : {}),
      // A window belongs to the model it was picked for: another model takes its own unless the same edit names one.
      ...("contextWindow" in (body ?? {})
        ? { contextWindow: readContextWindow(body?.contextWindow) }
        : "model" in (body ?? {}) && body?.model !== current.model
          ? { contextWindow: undefined }
          : {}),
    });
    return c.json(record);
  });

  // --- 排队 -------------------------------------------------------------

  /**
   * 运行中按 Enter 就排到这里，回合正常结束后 server 自己发出下一条 —— 浏览器
   * 关掉也一样。Queueing itself is allowed in any status: the user is typing
   * while something runs, and 「等它结束」 is the whole point.
   */
  app.post("/api/threads/:id/queue", async (c) => {
    const id = c.req.param("id");
    await threadOf(id);
    const body = (await c.req.json().catch(() => undefined)) as { text?: unknown } | undefined;
    const record = await queue.append(id, readQueueText(body?.text));
    // A turn can settle between the client seeing 「运行中」 and this write
    // landing. The dispatcher already ran on an empty queue by then, so it is
    // nudged again — it re-checks the status and does nothing unless the
    // thread really is idle.
    void runs.dispatchQueue(id).catch((error: unknown) => log.warn(`线程 ${id} 的排队消息没能发出`, error));
    return c.json(record);
  });

  app.patch("/api/threads/:id/queue/:itemId", async (c) => {
    const id = c.req.param("id");
    await threadOf(id);
    const body = (await c.req.json().catch(() => undefined)) as { text?: unknown } | undefined;
    return c.json(await queue.edit(id, c.req.param("itemId"), readQueueText(body?.text)));
  });

  app.delete("/api/threads/:id/queue/:itemId", async (c) => {
    const id = c.req.param("id");
    await threadOf(id);
    return c.json(await queue.remove(id, c.req.param("itemId")));
  });

  /**
   * 「发送」 on a paused queue: the user decides the stopped or failed turn is
   * dealt with and this item may go now. Same start path as everything else.
   *
   * `{ interrupt: true }` is 「打断并发送」 on a live task: the running (or
   * parked) turn is stopped first, exactly as 停止 would, and then this item
   * goes. Without it a live task still answers 409 — nothing jumps a running
   * turn by accident.
   */
  app.post("/api/threads/:id/queue/:itemId/send", async (c) => {
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = (await c.req.json().catch(() => undefined)) as { interrupt?: unknown } | undefined;
    const thread = await threadOf(id);
    if (body?.interrupt === true && isLive(thread)) {
      // Checked before stopping: a stale item id must not cost the user their turn.
      if (thread.queue?.some((item) => item.id === itemId) !== true) {
        throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
      }
      await runs.stop(id);
    } else {
      assertNotLive(thread);
    }
    await runs.sendQueued(id, itemId);
    return c.json(await threadOf(id));
  });

  // --- 计划文档 -----------------------------------------------------------

  // The Plan turn's product: a markdown file the user edits by hand and Build
  // hands back to Agent mode verbatim. Not part of the thread record — see
  // `store/plans.ts`.
  app.get("/api/threads/:id/plan", async (c) => c.json(await plans.get((await threadOf(c.req.param("id"))).id)));

  app.put("/api/threads/:id/plan", async (c) => {
    const thread = await threadOf(c.req.param("id"));
    // Saving under a running turn would be overwritten by it the moment it ends.
    assertNotLive(thread);
    const body = (await c.req.json().catch(() => undefined)) as { content?: unknown } | undefined;
    return c.json(await plans.put(thread.id, readPlanContent(body?.content)));
  });

  // --- 草稿 -------------------------------------------------------------

  // 草稿任何情况下不丢: the composer's half-typed text, per task (or `new` for
  // the empty state). It lives here rather than in the browser because the
  // desktop shell's WebView gets a new origin — and so an empty `localStorage` —
  // on every launch. The client still caches it locally for the first paint.
  app.get("/api/drafts/:key", async (c) => c.json({ text: await drafts.get(readDraftKey(c.req.param("key"))) }));

  app.put("/api/drafts/:key", async (c) => {
    const key = readDraftKey(c.req.param("key"));
    const body = (await c.req.json().catch(() => undefined)) as { text?: unknown } | undefined;
    const text = readDraftText(body?.text);
    await drafts.put(key, text);
    return c.json({ text });
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

    const model = options.compactModel ?? resolveModel(thread.model ?? DEFAULT_VGENT_MODEL, await providers.list());
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
    await plans.remove(id).catch((error: unknown) => log.warn(`删除线程 ${id} 的计划文档失败`, error));
    // 附件 written out for a harness engine live under the data dir, keyed by thread.
    await rm(join(dataDir, "attachments", id), { recursive: true, force: true }).catch((error: unknown) =>
      log.warn(`删除线程 ${id} 的附件失败`, error),
    );
    await drafts.remove(id).catch((error: unknown) => log.warn(`删除线程 ${id} 的草稿失败`, error));
    // Checkpoint refs live in the project's own ref store, which every worktree
    // shares — removing the directory above does not take them with it.
    const project = thread == null || isNoProject(thread.projectId) ? undefined : await projects.get(thread.projectId);
    if (project != null) await deleteCheckpoints({ repoPath: project.repoPath, threadId: id, log });
    // 无项目: the task's directory was only ever its own.
    if (thread != null && isNoProject(thread.projectId)) {
      await rm(scratchDirOf(dataDir, id), { recursive: true, force: true }).catch((error: unknown) => log.warn(`删除线程 ${id} 的临时目录失败`, error));
    }
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
      // 系统通知: anything but `false` is「开」, which is the absence of the field.
      ...("systemNotifications" in (body ?? {})
        ? { systemNotifications: body?.systemNotifications === false ? false : undefined }
        : {}),
      // Unlike the scalars above, a malformed server list is rejected rather
      // than dropped: silently ignoring it would look exactly like an MCP
      // server whose tools never showed up.
      // Same convention as 系统通知: absent is on, only `false` is stored.
      ...("autoUpgradeRuntimes" in (body ?? {})
        ? { autoUpgradeRuntimes: body?.autoUpgradeRuntimes === false ? false : undefined }
        : {}),
      ...("mcpServers" in (body ?? {}) ? { mcpServers: readMcpServers(body?.mcpServers) } : {}),
      ...("worktreeMaxCount" in (body ?? {}) ? { worktreeMaxCount: readWorktreeMaxCount(body?.worktreeMaxCount) } : {}),
      // 界面偏好: the title bar's two toggles write them here, so they survive
      // the desktop shell's per-launch origin.
      ...("theme" in (body ?? {}) ? { theme: readTheme(body?.theme) } : {}),
      ...("density" in (body ?? {}) ? { density: readDensity(body?.density) } : {}),
    };
    return c.json(await settings.update(patch));
  });

  // 「一直允许」 on an approval card, and the 撤销 next to it in 设置. One tool at
  // a time, because that is how the two buttons think about it.
  // 记住上次选的引擎: one entry of a map, so it is a read-modify-write on the
  // server — two quick picks must not start from the same copy.
  app.put("/api/settings/model-engines", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { modelKey?: unknown; engine?: unknown } | undefined;
    const engine = asEngine(body?.engine);
    const modelKey = typeof body?.modelKey === "string" ? body.modelKey.trim() : "";
    if (engine == null || modelKey === "" || modelKey.length > 300) throw new BadRequestError("需要 modelKey 和 engine", "invalid_model_engine");
    return c.json(await settings.mutate((current) => ({ modelEngines: { ...current.modelEngines, [modelKey]: engine } })));
  });

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

  // --- providers --------------------------------------------------------

  // 模型提供商: an account (endpoints + key) and, per agent, the models the user
  // ticked. Keys go in and never come out — every response is the redacted form.

  const readProviderBody = async (c: { req: { json(): Promise<unknown> } }): Promise<ProviderInput> => {
    const body = await c.req.json().catch(() => undefined);
    try {
      return parseProviderInput(body);
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error), "invalid_provider");
    }
  };

  app.get("/api/providers", async (c) => c.json({ providers: (await providers.list()).map(redactProvider) }));

  // 提供商目录: every provider there is to connect (models.dev, cached), without
  // their models — those come one provider at a time, when the user picks one.
  app.get("/api/providers/catalog", async (c) => {
    const snapshot = c.req.query("refresh") != null ? await catalog.refresh() : await catalog.get();
    return c.json({
      source: snapshot.source,
      ...(snapshot.fetchedAt != null ? { fetchedAt: snapshot.fetchedAt } : {}),
      popular: POPULAR_PROVIDER_IDS.filter((id) => snapshot.providers.some((entry) => entry.id === id)),
      providers: snapshot.providers.map(summarizeCatalogProvider),
    });
  });

  app.get("/api/providers/catalog/:id", async (c) => {
    const id = c.req.param("id");
    const entry = (await catalog.get()).providers.find((provider) => provider.id === id);
    if (entry == null) throw new NotFoundError(`目录里没有提供商 ${JSON.stringify(id)}`, "provider_not_found");
    return c.json(entry);
  });

  app.post("/api/providers", async (c) => c.json(redactProvider(await providers.create(await readProviderBody(c))), 201));

  app.patch("/api/providers/:id", async (c) => c.json(redactProvider(await providers.update(c.req.param("id"), await readProviderBody(c)))));

  app.delete("/api/providers/:id", async (c) => {
    await providers.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // 拉模型清单. Works before the provider is saved (the form sends the key it
  // holds) and after (`providerId` alone uses the stored key), so「拉下来我选」
  // never needs the key typed twice.
  app.post("/api/providers/discover", async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as
      | { providerId?: unknown; baseURL?: unknown; protocol?: unknown; apiKey?: unknown }
      | undefined;
    const baseURL = typeof body?.baseURL === "string" ? body.baseURL.trim() : "";
    if (baseURL === "") throw new BadRequestError("缺少 baseURL", "invalid_provider");
    const protocol = body?.protocol ?? "openai-compatible";
    if (!(PROVIDER_PROTOCOLS as readonly unknown[]).includes(protocol)) throw new BadRequestError("protocol 不合法", "invalid_provider");
    const stored = typeof body?.providerId === "string" ? await providers.get(body.providerId) : undefined;
    const apiKey = typeof body?.apiKey === "string" && body.apiKey.trim() !== "" ? body.apiKey.trim() : stored?.apiKey;
    try {
      const models = await discoverProviderModels({
        baseURL,
        protocol: protocol as ProviderProtocol,
        ...(apiKey != null ? { apiKey } : {}),
        ...(options.providerFetch != null ? { fetch: options.providerFetch } : {}),
        signal: c.req.raw.signal,
      });
      return c.json({ models });
    } catch (error) {
      if (error instanceof ModelDiscoveryError) {
        // The provider answered and said no to the key: the one failure the connect dialog must not shrug off.
        const rejected = error.status === 401 || error.status === 403;
        throw new UpstreamModelError(error.message, rejected ? "provider_key_rejected" : "provider_discovery_failed");
      }
      throw error;
    }
  });

  // --- engines ----------------------------------------------------------

  // 引擎能力表. The client shows what an engine can do from this and never
  // branches on its name.
  // --- 引擎运行时 ---------------------------------------------------------
  // Which Claude Code / Codex is installed, what the newest is, and moving
  // between them. An install takes a while, so both POSTs answer when it is
  // over — with the fresh status, or with why it was refused or rolled back.
  const asRuntimeEngine = (value: string): HarnessEngineId => {
    if (value === "claude-code" || value === "codex") return value;
    throw new NotFoundError(`${value} 没有可升级的运行时`);
  };
  app.get("/api/runtimes", async (c) => c.json({ runtimes: await harnessRuntime.status() }));
  app.post("/api/runtimes/check", async (c) => c.json({ runtimes: await harnessRuntime.check() }));
  app.post("/api/runtimes/:engine/upgrade", async (c) =>
    c.json(await harnessRuntime.upgrade(asRuntimeEngine(c.req.param("engine")))),
  );
  app.post("/api/runtimes/:engine/rollback", async (c) =>
    c.json(await harnessRuntime.rollback(asRuntimeEngine(c.req.param("engine")))),
  );

  // 自动升级: a minute after start (the first window must not wait on npm), then
  // every six hours. Skipped per engine while a task of it is live, so a busy
  // day simply upgrades at the next quiet tick.
  const RUNTIME_CHECK_MS = 6 * 60 * 60 * 1000;
  const autoUpgradeTick = (): void => {
    void settings
      .get()
      .then((current) => (current.autoUpgradeRuntimes === false ? undefined : harnessRuntime.autoUpgrade()))
      .catch((error: unknown) => log.warn("自动升级引擎运行时失败", error));
  };
  const runtimeTimers: NodeJS.Timeout[] = [];
  // An install the last run did not live to finish leaves an engine unable to
  // start; putting it back is the first thing a new run does, asked or not.
  void harnessRuntime.recover();
  if (options.autoUpgradeRuntimes === true) {
    runtimeTimers.push(setTimeout(autoUpgradeTick, 60_000), setInterval(autoUpgradeTick, RUNTIME_CHECK_MS));
    for (const timer of runtimeTimers) timer.unref();
  }

  app.get("/api/engines", (c) => c.json({ engines: engineDescriptors(registry) }));

  // --- model catalog ----------------------------------------------------

  const modelCatalog = createModelCatalog({
    log,
    anthropicModels: async () => (await catalog.get()).providers.find((entry) => entry.id === "anthropic")?.models ?? [],
    catalogModelOf: async () => createModelIndex((await catalog.get()).providers),
  });

  app.get("/api/engines/:engine/models", async (c) => {
    const raw = c.req.param("engine");
    const engine = asEngine(raw);
    if (engine == null) throw new BadRequestError(`未知引擎: ${JSON.stringify(raw)}`, "unknown_engine");
    const listing = await modelCatalog.list(engine, { refresh: c.req.query("refresh") === "1" });
    // The list is cached per engine; the effective default is a setting, so it
    // is merged in per request instead of baked into the cached catalog. A model
    // id means something to exactly one engine, so `defaultModel` only answers
    // for the engine it was picked under; the others fall back to what we know
    // of their own default — see `DEFAULT_VGENT_MODEL`.
    const current = await settings.get();
    const defaultModel =
      (engine === current.defaultEngine ? current.defaultModel : undefined) ??
      (capabilitiesOf(engine).knownDefaultModel ? DEFAULT_VGENT_MODEL : undefined);
    // Provider models are merged per request for the same reason: the list is
    // the user's, edited on the settings page, and must not wait out a cache.
    const known = capabilitiesOf(engine).customProviders ? (await catalog.get()).providers : undefined;
    const modelOf = known != null ? createModelIndex(known) : undefined;
    const hasLogo = new Set(known?.map((entry) => entry.id));
    const fromProviders: ModelEntry[] = modelOf != null
      ? (await providers.list()).flatMap((provider) =>
          (provider.agents[engine]?.models ?? []).map((model) => {
            const listed = modelOf(model.id);
            // A window the user never stored is the catalog's word for the model.
            const window = model.contextWindow ?? listed?.contextWindow;
            return {
              id: providerModelSpec(provider.id, model.id),
              label: model.label ?? model.id,
              provider: provider.name,
              // One key across the agents it is switched on for: it is one model.
              modelKey: `${provider.id}/${model.id}`,
              source: { kind: "provider" as const, id: provider.id, name: provider.name, ...(hasLogo.has(provider.id) ? { logo: provider.id } : {}) },
              ...(listed?.vendor != null ? { vendor: listed.vendor } : {}),
              ...reasoningFor(engine, listed?.reasoningLevels),
              ...contextOptionsFor(engine, model.contextWindow, listed?.contextWindow),
              ...(window != null ? { contextWindow: window } : {}),
            };
          }),
        )
      : [];
    // What the 模型 table switched off stays in the list, marked: see `ModelEntry.hidden`.
    const own = markHidden(listing.models, current.hiddenModels?.[engine]);
    return c.json({ ...listing, models: [...own, ...fromProviders], ...(defaultModel != null ? { defaultModel } : {}) });
  });

  // --- subscriptions ----------------------------------------------------

  // 订阅: the Claude and Codex logins, listed with the providers because that is
  // what they are to the user. Nothing here signs anyone in or holds a token —
  // it reports the login the vendor's CLI made, and keeps the model switches.
  const subscriptions = createSubscriptionService({
    modelCatalog,
    ...(options.probeClaudeLogin != null ? { probeClaude: options.probeClaudeLogin } : {}),
  });

  app.get("/api/subscriptions", async (c) =>
    c.json({ subscriptions: await subscriptions.list(await settings.get(), { refresh: c.req.query("refresh") === "1" }) }),
  );

  // One switch, or a whole column of them. Addressed by the table's row ids; the
  // per-agent model id behind each is ours to know, not the client's.
  app.put("/api/subscriptions/:id/models", async (c) => {
    const id = c.req.param("id") as SubscriptionId;
    if (!SUBSCRIPTION_IDS.includes(id)) throw new NotFoundError(`没有订阅 ${JSON.stringify(id)}`, "subscription_not_found");
    const body = (await c.req.json().catch(() => undefined)) as { agent?: unknown; models?: unknown; enabled?: unknown } | undefined;
    const agent = asEngine(body?.agent);
    const rowIds = Array.isArray(body?.models) ? body.models.filter((entry): entry is string => typeof entry === "string") : [];
    if (agent == null || typeof body?.enabled !== "boolean") throw new BadRequestError("需要 agent、models 和 enabled", "invalid_subscription_models");
    const rows = await subscriptions.models(id, await settings.get());
    const specs = rows.flatMap((row) => (rowIds.includes(row.id) && row.agents[agent] != null ? [row.agents[agent].spec] : []));
    const enabled = body.enabled;
    const next = await settings.mutate((current) => ({ hiddenModels: withHiddenModels(current.hiddenModels, agent, specs, enabled) }));
    return c.json({ models: await subscriptions.models(id, next) });
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
      for (const timer of runtimeTimers) clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      clients.clear();
      await runs.stopAll();
    },
  };
}
