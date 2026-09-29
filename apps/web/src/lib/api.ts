import type { FileUIPart } from "ai";
import { modelsChanged } from "./modelEvents";
import { accountsChanged } from "./accountEvents";
import type { AccountKind, AccountLoginAttempt, AccountSnapshot, AccountUse } from "./types";
import type {
  RemoteAccessState,
  HarnessEngineId,
  HarnessRuntimeStatus,
  ChangesResponse,
  ChangesScope,
  CuaStatus,
  CuaTestResult,
  CheckpointPreview,
  CheckpointRestore,
  EngineDescriptor,
  EngineId,
  FileContent,
  ResolvedFile,
  FileDiff,
  FileListing,
  IntegrateAction,
  IntegrateResponse,
  IntegrationStatus,
  ModelCatalog,
  PlanDocument,
  Project,
  CatalogProvider,
  CatalogProviderSummary,
  ProviderAgent,
  ProviderAgentConfig,
  ProviderModel,
  ProviderProtocol,
  RedactedProviderConfig,
  SubscriptionAccount,
  SubscriptionId,
  SubscriptionModel,
  Settings,
  SetupLog,
  ThreadMode,
  ThreadRecord,
  ThreadSummary,
  WorkspaceMode,
} from "./types";
import type { DraftPayload, DraftValue } from "./drafts";
import { pickNativePath } from "./nativePicker";

/** What the provider form sends. The key travels up only; nothing the server answers carries one. */
export interface ProviderCatalog {
  /** `builtin`: models.dev could not be reached and there is no cached copy — only the handful shipped with the app. */
  source: "live" | "cache" | "builtin";
  fetchedAt?: string;
  /** Catalog ids of the first rows, in order. */
  popular: string[];
  providers: CatalogProviderSummary[];
}

export interface ProviderInputBody {
  name: string;
  presetId?: string;
  apiKey?: string;
  agents: Partial<Record<ProviderAgent, ProviderAgentConfig>>;
}

/** A change to one model's remembered choices (`Settings.modelPicks`): `null` hands a field back to the model's own default. */
export interface ModelPickPatch {
  engine?: EngineId;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  contextWindow?: number | null;
}

const TOKEN_KEY = "vgent.token";

/**
 * Dispatched on `window` the first time the server rejects our token. Every
 * caller stops on it: the app drops back to the token screen, and nothing may
 * retry with the token that was just cleared.
 */
export const UNAUTHORIZED_EVENT = "vgent:unauthorized";

/** Reads `#token=…` (it wins over the stored one), persists it, strips the URL. */
export function bootstrapToken(): string | null {
  // The private relay has already authenticated this browser as the owner.
  // This public marker never grants access to the local listener.
  if (window.location.protocol === "https:" && window.location.hostname.endsWith(".devtunnels.ms")) {
    setToken("vgent-remote-session");
    return "vgent-remote-session";
  }
  const match = /[#&]token=([^&]*)/.exec(window.location.hash);
  if (match?.[1] != null) {
    sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(match[1]));
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return getToken();
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Drops the rejected token and tells the app to ask for a new one. */
export function reportUnauthorized(): void {
  clearToken();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

export const UNAUTHORIZED_MESSAGE = "token 无效或已过期";

/** Carries the server's typed `{ code, status, details }` so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The structured half of a failure — 带回主目录's conflict list, and nothing else so far. */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Whether a token still works. `EventSource` hides the status code of a failed
 * connection, so the SSE hook asks this before it schedules another reconnect.
 */
export async function probeToken(token: string): Promise<boolean> {
  const response = await fetch("/api/projects", { headers: authHeaders(token) });
  return response.status !== 401;
}

export function authHeaders(token: string): Record<string, string> {
  return { "x-vgent-token": token };
}

/** EventSource can't set headers, so the SSE routes take the token as a query param. */
export function sseUrl(path: string, token: string): string {
  return `${path}?token=${encodeURIComponent(token)}`;
}

/** Fetches `/api<path>` with the auth header; throws on `{ error: { code, message } }`. */
export async function api<T>(
  path: string,
  token: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const response = await fetch(`/api${path}`, {
    ...rest,
    headers: {
      ...authHeaders(token),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });

  if (response.status === 401) {
    reportUnauthorized();
    throw new ApiError(UNAUTHORIZED_MESSAGE, 401, "unauthorized");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string; details?: unknown } }
      | null;
    throw new ApiError(
      body?.error?.message ?? `${response.status} ${response.statusText}`,
      response.status,
      body?.error?.code,
      body?.error?.details,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The same fetch for a body that is not JSON: a file's own bytes. */
async function apiBlob(path: string, token: string): Promise<Blob> {
  const response = await fetch(`/api${path}`, { headers: authHeaders(token) });
  if (response.status === 401) {
    reportUnauthorized();
    throw new ApiError(UNAUTHORIZED_MESSAGE, 401, "unauthorized");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(body?.error?.message ?? `${response.status} ${response.statusText}`, response.status, body?.error?.code);
  }
  return response.blob();
}

/** One typed call per route in `packages/server/src/app.ts`. */
export function createClient(token: string) {
  const notify = <T,>(value: T): T => { accountsChanged(client); return value; };
  const notifyModels = <T,>(value: T): T => { modelsChanged(client); return value; };
  let loginState = "idle";
  let remoteIdentity: string | undefined;
  let subscriptionIdentity: string | undefined;
  const trackRemote = (state: RemoteAccessState) => {
    const identity = JSON.stringify([state.accountId, state.account, state.enabled]);
    if (remoteIdentity != null && remoteIdentity !== identity) notify(state);
    remoteIdentity = identity;
    return state;
  };
  const client = {
    token,
    remoteSession: token === "vgent-remote-session",
    getAccounts: (usage = false, refresh = false) => api<AccountSnapshot>(`/accounts?usage=${usage ? "1" : "0"}&refresh=${refresh ? "1" : "0"}`, token),
    /** 登录: a new account of `kind`, or `accountId` again. One runs at a time; the server answers with it as it stands. */
    startAccountLogin: (kind: AccountKind, accountId?: string) =>
      api<AccountLoginAttempt>("/accounts/login", token, { method: "POST", json: { kind, ...(accountId != null ? { accountId } : {}) } }).then((attempt) => { loginState = attempt.state; return attempt; }),
    getAccountLogin: () =>
      api<AccountLoginAttempt>("/accounts/login", token).then((attempt) => {
        if (attempt.state === "succeeded" && loginState !== "succeeded") notify(attempt);
        loginState = attempt.state;
        return attempt;
      }),
    cancelAccountLogin: () => api<AccountLoginAttempt>("/accounts/login", token, { method: "DELETE" }).then((attempt) => { loginState = attempt.state; return attempt; }),
    /** 退出登录. For the machine's own login, the terminal is signed out too. */
    logoutAccount: (id: string) => api<AccountSnapshot>(`/accounts/${encodeURIComponent(id)}`, token, { method: "DELETE" }).then(notify),
    /** One of an account's 用途 switches. */
    setAccountUse: (id: string, use: AccountUse, enabled: boolean) =>
      api<AccountSnapshot>(`/accounts/${encodeURIComponent(id)}/uses`, token, { method: "PUT", json: { use, enabled } }).then(notify),
    getRemote: () => api<RemoteAccessState>("/remote", token).then(trackRemote),
    remoteAction: (action: "selectAccount" | "refresh" | "setEnabled" | "rename", input: { accountId?: string | null; enabled?: boolean; name?: string } = {}) =>
      api<RemoteAccessState>("/remote", token, { method: "POST", json: { action, ...input } }).then(trackRemote),
    health: () => api<{ ok: boolean; version: string }>("/health", token),

    listProjects: () => api<{ projects: Project[] }>("/projects", token).then((body) => body.projects),
    createProject: (repoPath: string, name?: string) =>
      api<Project & { note?: string }>("/projects", token, {
        method: "POST",
        json: { repoPath, ...(name != null ? { name } : {}) },
      }),
    deleteProject: (id: string) => api<void>(`/projects/${id}`, token, { method: "DELETE" }),
    /**
     * The branch this project's checkout is on right now — what the row under
     * the composer shows before a task exists. `null` means a detached HEAD.
     */
    getProjectBranch: (id: string) =>
      api<{ repoPath: string; branch: string | null }>(`/projects/${id}/branch`, token),
    /**
     * Native folder chooser — the desktop shell's own dialog when there is one,
     * the server's `osascript` panel otherwise. `null` means the user cancelled,
     * which must not be mistaken for "no native picker here".
     */
    pickFolder: async () => {
      const native = await pickNativePath("folder");
      if (native !== undefined) return native;
      const body = await api<{ path: string } | undefined>("/projects/pick", token, { method: "POST" });
      return body?.path ?? null;
    },
    /** Same chooser, restricted to a single file — for an MCP server's executable. */
    pickFile: async () => {
      const native = await pickNativePath("file");
      if (native !== undefined) return native;
      const body = await api<{ path: string } | undefined>("/projects/pick", token, {
        method: "POST",
        json: { kind: "file" },
      });
      return body?.path ?? null;
    },

    // Changes are keyed by thread: a task in its own worktree diffs that
    // directory, every other task diffs the project's working tree. `scope`
    // picks 「上一轮」 instead — the last turn's two snapshots against each other.
    listChanges: (threadId: string, scope: ChangesScope = "all") =>
      api<ChangesResponse>(`/threads/${threadId}/changes${scope === "all" ? "" : `?scope=${scope}`}`, token),
    getFileDiff: (threadId: string, path: string, scope: ChangesScope = "all") =>
      api<FileDiff>(
        `/threads/${threadId}/changes/file?path=${encodeURIComponent(path)}${scope === "all" ? "" : `&scope=${scope}`}`,
        token,
      ),
    revertFile: (threadId: string, path: string) =>
      api<{ path: string }>(`/threads/${threadId}/changes/revert`, token, { method: "POST", json: { path } }),

    /** 收口: what this task can do with its changes right now. */
    getIntegration: (threadId: string) => api<IntegrationStatus>(`/threads/${threadId}/integration`, token),
    /**
     * 提交 / 开 PR / 带回主目录 / 全部丢弃 / 撤销带回. `message` is required for
     * 提交 and for a dirty PR; `conflicts: "markers"` is the explicit
     * 「带冲突标记合并」, which the bar only offers after a refused 带回.
     */
    integrate: (threadId: string, action: IntegrateAction, input?: { message?: string; conflicts?: "markers" }) =>
      api<IntegrateResponse>(`/threads/${threadId}/integrate`, token, {
        method: "POST",
        json: {
          action,
          ...(input?.message != null ? { message: input.message } : {}),
          ...(input?.conflicts != null ? { conflicts: input.conflicts } : {}),
        },
      }),

    // Same directory as the changes routes: the whole working tree this time,
    // for the 文件 tab and the composer's `@` completion.
    listFiles: (threadId: string, opts?: { q?: string; limit?: number }) => {
      const query = new URLSearchParams();
      if (opts?.q != null && opts.q !== "") query.set("q", opts.q);
      if (opts?.limit != null) query.set("limit", String(opts.limit));
      const search = query.size > 0 ? `?${query.toString()}` : "";
      return api<FileListing>(`/threads/${threadId}/files${search}`, token);
    },
    getFileContent: (threadId: string, path: string) =>
      api<FileContent>(`/threads/${threadId}/files/content?path=${encodeURIComponent(path)}`, token),
    /** The file itself; `path` may be absolute, as long as it is inside the task's directory. */
    getFileBlob: (threadId: string, path: string) => apiBlob(`/threads/${threadId}/files/raw?path=${encodeURIComponent(path)}`, token),
    /** 「下载」: a copy in the Downloads folder, of a file of the task or of a drawing that exists only in a reply. */
    downloadFile: async (threadId: string, content: { path: string } | { svg: string }) => {
      if (token !== "vgent-remote-session") return api<{ savedTo: string }>(`/threads/${threadId}/files/download`, token, { method: "POST", json: content });
      const blob = "path" in content
        ? await apiBlob(`/threads/${threadId}/files/raw?path=${encodeURIComponent(content.path)}`, token)
        : new Blob([content.svg], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "path" in content ? content.path.split(/[\\/]/).pop() || "download" : "image.svg";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return { savedTo: "浏览器下载" };
    },
    /** Of these paths — as tools and replies wrote them — the ones that are this task's files right now. */
    resolveFiles: (threadId: string, paths: string[]) =>
      api<{ files: ResolvedFile[] }>(`/threads/${threadId}/files/resolve`, token, { method: "POST", json: { paths } }).then((body) => body.files),

    listThreads: () => api<{ threads: ThreadSummary[] }>("/threads", token).then((body) => body.threads),
    createThread: (input: {
      projectId: string;
      title?: string;
      engine?: EngineId;
      model?: string;
      /** The model's「思考等级」; omitted leaves the engine's own default. */
      reasoningEffort?: string;
      /** Fast and the like: a service tier id the model's catalog entry offers. */
      serviceTier?: string;
      /** 上下文: one of the model's `contextOptions`, in tokens. */
      contextWindow?: number;
      /** `worktree` gives the task its own checkout; the default edits the project. */
      workspace?: WorkspaceMode;
      /** Return the session while its worktree is being created. */
      deferWorkspace?: boolean;
      /** 模式 of the first turn; `plan` needs an engine with `capabilities.planMode`. */
      mode?: ThreadMode;
    }) => api<ThreadRecord>("/threads", token, { method: "POST", json: input }),
    getThread: (id: string) => api<ThreadRecord>(`/threads/${id}`, token),
    patchThread: (
      id: string,
      patch: {
        title?: string;
        /** Picking another engine's model changes both at once; only an empty thread may. */
        engine?: EngineId;
        model?: string | null;
        /** `null` clears it and hands the level back to the engine. */
        reasoningEffort?: string | null;
        /** `null` puts the task back on the standard tier. */
        serviceTier?: string | null;
        /** `null` hands the window back to the engine's own for the model. */
        contextWindow?: number | null;
        /** Agent / Plan for the next turn. Refused while the task is live. */
        mode?: ThreadMode;
        /** 归档 also reclaims the task's worktree; un-archiving restores it. */
        archived?: boolean;
        /** With `archived: true`: the user confirmed that the worktree's uncommitted changes go along. Without it a dirty worktree is refused. */
        preserveChanges?: boolean;
        /** 未读. The one field a running task still takes, because reading is not editing. */
        unread?: boolean;
      },
    ) => api<ThreadRecord>(`/threads/${id}`, token, { method: "PATCH", json: patch }),
    deleteThread: (id: string) => api<void>(`/threads/${id}`, token, { method: "DELETE" }),

    /** Keeps a task's changes in git and removes the directory; reversible. A dirty one needs `preserveChanges`. */
    reclaimWorkspace: (id: string, preserveChanges: boolean) =>
      api<ThreadRecord>(`/threads/${id}/workspace/reclaim`, token, { method: "POST", json: { preserveChanges } }),
    /** How many files the task's worktree has not committed — what 归档 / 回收 would take along. */
    uncommittedFiles: (id: string) =>
      api<{ files: number }>(`/threads/${id}/workspace/uncommitted`, token).then((body) => body.files),
    restoreWorkspace: (id: string) =>
      api<ThreadRecord>(`/threads/${id}/workspace/restore`, token, { method: "POST" }),

    /**
     * 恢复到此处: put the files the task touched back to the state before
     * `messageId` ran — or, for 「回到最新」, all the way forward again. Only the
     * files the turns in between touched move; the conversation is never touched.
     */
    restoreCheckpoint: (threadId: string, target: { messageId: string } | { latest: true }) =>
      api<CheckpointRestore>(`/threads/${threadId}/checkpoints/restore`, token, { method: "POST", json: target }),
    /** What that restore would move, for the sentence the user confirms. */
    previewRestore: (threadId: string, target: { messageId: string } | { latest: true }) =>
      api<CheckpointPreview>(
        `/threads/${threadId}/checkpoints/preview?${"latest" in target ? "latest=1" : `messageId=${encodeURIComponent(target.messageId)}`}`,
        token,
      ),

    /** 分叉: a new task with the conversation up to the end of the turn this user message started. */
    forkThread: (threadId: string, messageId: string) =>
      api<ThreadRecord>(`/threads/${threadId}/fork`, token, { method: "POST", json: { messageId } }),

    /** Durable follow-up; mode chooses current-turn steer or next-turn queue. */
    queueMessage: (threadId: string, text: string, mode: "steer" | "queue" = "steer", files: FileUIPart[] = []) =>
      api<ThreadRecord>(`/threads/${threadId}/queue`, token, { method: "POST", json: { text, mode, files } }),
    reorderQueue: (threadId: string, ids: readonly string[]) =>
      api<ThreadRecord>(`/threads/${threadId}/queue/order`, token, { method: "PUT", json: { ids } }),
    steerQueued: (threadId: string, itemId: string) =>
      api<ThreadRecord>(`/threads/${threadId}/queue/${itemId}/steer`, token, { method: "POST" }),
    editQueued: (threadId: string, itemId: string, text: string) =>
      api<ThreadRecord>(`/threads/${threadId}/queue/${itemId}`, token, { method: "PATCH", json: { text } }),
    deleteQueued: (threadId: string, itemId: string) =>
      api<ThreadRecord>(`/threads/${threadId}/queue/${itemId}`, token, { method: "DELETE" }),
    /**
     * 「发送」 on a paused queue: run this one now. Refused while the task is
     * live, unless `interrupt` — 「打断并发送」 stops the running turn first.
     */
    sendQueued: (threadId: string, itemId: string, options: { interrupt?: boolean } = {}) =>
      api<ThreadRecord>(`/threads/${threadId}/queue/${itemId}/send`, token, {
        method: "POST",
        json: options.interrupt === true ? { interrupt: true } : {},
      }),

    /** What the project's worktree setup script printed, for the 终端 tab. */
    getSetupLog: (id: string) => api<SetupLog>(`/threads/${id}/workspace/setup-log`, token),

    /**
     * 草稿: the composer's half-typed text and the files waiting with it, per
     * task (`NEW_TASK_DRAFT` for the empty state). It lives on the server because
     * the desktop shell's WebView gets a new origin — and an empty `localStorage`
     * — on every launch. A file's bytes travel once, as a `data:` URL; later
     * writes name it by id. `keepalive` lets the last write go out from a page
     * that is already leaving.
     */
    getDraft: (key: string) => api<DraftValue>(`/drafts/${encodeURIComponent(key)}`, token),
    putDraft: (key: string, draft: DraftPayload, options?: { keepalive?: boolean }) =>
      api<DraftValue>(`/drafts/${encodeURIComponent(key)}`, token, {
        method: "PUT",
        json: draft,
        ...(options?.keepalive === true ? { keepalive: true } : {}),
      }).then(() => undefined),

    /** 计划文档: the Plan turn's product, which the user edits before Build. Empty content = none yet. */
    getPlan: (threadId: string) => api<PlanDocument>(`/threads/${threadId}/plan`, token),
    putPlan: (threadId: string, content: string) =>
      api<PlanDocument>(`/threads/${threadId}/plan`, token, { method: "PUT", json: { content } }),

    /** `/compact`: replaces the task's whole history with a summary of it. Vgent engine only. */
    compactThread: (id: string) => api<ThreadRecord>(`/threads/${id}/compact`, token, { method: "POST" }),

    /** 引擎能力表: what exists, what it is called, what it can do. */
    listEngines: () => api<{ engines: EngineDescriptor[] }>("/engines", token).then((body) => body.engines),

    /** 模型提供商: the connected ones, never with their key. */
    listProviders: () => api<{ providers: RedactedProviderConfig[] }>("/providers", token).then((body) => body.providers),
    /** 提供商目录 (models.dev, cached by the server), without models. `refresh` downloads it again. */
    getProviderCatalog: (refresh = false) => api<ProviderCatalog>(`/providers/catalog${refresh ? "?refresh=1" : ""}`, token),
    /** One catalog provider with the models an agent can use. */
    getCatalogProvider: (id: string) => api<CatalogProvider>(`/providers/catalog/${encodeURIComponent(id)}`, token),
    createProvider: (input: ProviderInputBody) => api<RedactedProviderConfig>("/providers", token, { method: "POST", json: input }).then(notifyModels),
    /** `apiKey` absent keeps the stored key, `""` clears it. */
    updateProvider: (id: string, input: ProviderInputBody) =>
      api<RedactedProviderConfig>(`/providers/${encodeURIComponent(id)}`, token, { method: "PATCH", json: input }).then(notifyModels),
    deleteProvider: (id: string) => api<void>(`/providers/${encodeURIComponent(id)}`, token, { method: "DELETE" }).then(notifyModels),
    /** 拉模型清单. With `providerId` and no `apiKey`, the server uses the key it has stored. */
    /** The accounts that bring models, one row each. `refresh` re-asks the vendors for their model lists. */
    listSubscriptions: (refresh = false) =>
      api<{ subscriptions: SubscriptionAccount[] }>(`/subscriptions${refresh ? "?refresh=1" : ""}`, token).then((body) => {
        const identity = JSON.stringify(body.subscriptions.map(a => [a.id, a.agents, a.email, a.username, a.method]));
        if (subscriptionIdentity != null && subscriptionIdentity !== identity) notify(body);
        subscriptionIdentity = identity;
        if (refresh) notifyModels(body);
        return body.subscriptions;
      }),
    /** One switch of a subscription's model table, or a column of them. Answers with the table as it now stands. */
    setSubscriptionModels: (id: SubscriptionId, input: { agent: EngineId; models: string[]; enabled: boolean }) =>
      api<{ models: SubscriptionModel[] }>(`/subscriptions/${encodeURIComponent(id)}/models`, token, { method: "PUT", json: input }).then((body) => notifyModels(body.models)),
    discoverProviderModels: (input: { providerId?: string; baseURL: string; protocol: ProviderProtocol; apiKey?: string }) =>
      api<{ models: ProviderModel[] }>("/providers/discover", token, { method: "POST", json: input }).then((body) => body.models),

    /** The engine's model list. `refresh` skips the server's 10-minute cache. */
    listModels: (engine: EngineId, refresh = false) =>
      api<ModelCatalog>(`/engines/${engine}/models${refresh ? "?refresh=1" : ""}`, token),

    /** 引擎运行时: which Claude Code / Codex is installed, and what the newest is. */
    listRuntimes: () => api<{ runtimes: HarnessRuntimeStatus[] }>("/runtimes", token).then((body) => body.runtimes),
    /** Asks npm again first. */
    checkRuntimes: () =>
      api<{ runtimes: HarnessRuntimeStatus[] }>("/runtimes/check", token, { method: "POST" }).then((body) => body.runtimes),
    /** Answers when the install is over: the fresh status, or why it was refused or rolled back. */
    upgradeRuntime: (engine: HarnessEngineId) =>
      api<HarnessRuntimeStatus>(`/runtimes/${engine}/upgrade`, token, { method: "POST" }),
    rollbackRuntime: (engine: HarnessEngineId) =>
      api<HarnessRuntimeStatus>(`/runtimes/${engine}/rollback`, token, { method: "POST" }),

    getSettings: () => api<Settings>("/settings", token),
    putSettings: (patch: Partial<Omit<Settings, "worktreeMaxCount">> & { worktreeMaxCount?: number | null }) => api<Settings>("/settings", token, { method: "PUT", json: patch }),
    getCuaStatus: () => api<CuaStatus>("/computer-use/cua/status", token),
    startCuaDriver: () => api<CuaStatus>("/computer-use/cua/start", token, { method: "POST" }),
    requestCuaPermissions: () => api<CuaStatus>("/computer-use/cua/permissions", token, { method: "POST" }),
    testCuaDriver: () => api<CuaTestResult>("/computer-use/cua/test", token, { method: "POST" }),

    /**
     * 「一直允许」 on an approval card: one tool onto the global allowlist, right
     * now — it is clicked mid-turn, so it cannot go through the settings draft.
     * Taking one back off is an ordinary settings edit (`putSettings`).
     */
    /** 记住上次选择, for the model with this `modelKey`: only the fields named change. */
    rememberModelPick: (modelKey: string, pick: ModelPickPatch) =>
      api<Settings>("/settings/model-picks", token, { method: "PUT", json: { modelKey, ...pick } }),
    /** 提供商排序: the whole「已添加」list's order, by subscription or provider id. */
    putProviderOrder: (order: readonly string[]) => api<Settings>("/settings/provider-order", token, { method: "PUT", json: { order } }).then(notifyModels),
    allowTool: (tool: string) => api<Settings>("/settings/allowlist", token, { method: "POST", json: { tool } }),

    stopChat: (threadId: string) => api<void>(`/chat/${threadId}/stop`, token, { method: "POST" }),
  };
  return client;
}

export type ApiClient = ReturnType<typeof createClient>;
