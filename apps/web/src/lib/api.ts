import type {
  ChangesSnapshot,
  CheckpointRestore,
  EngineDescriptor,
  EngineId,
  FileContent,
  FileDiff,
  FileListing,
  IntegrateAction,
  IntegrationStatus,
  ModelCatalog,
  PlanDocument,
  Project,
  Settings,
  SetupLog,
  ThreadMode,
  ThreadRecord,
  ThreadSummary,
  WorkspaceMode,
} from "./types";
import { pickNativePath } from "./nativePicker";

const TOKEN_KEY = "vgent.token";

/**
 * Dispatched on `window` the first time the server rejects our token. Every
 * caller stops on it: the app drops back to the token screen, and nothing may
 * retry with the token that was just cleared.
 */
export const UNAUTHORIZED_EVENT = "vgent:unauthorized";

/** Reads `#token=…` (it wins over the stored one), persists it, strips the URL. */
export function bootstrapToken(): string | null {
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

/** Carries the server's typed `{ code, status }` so callers can branch on it. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
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
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiError(
      body?.error?.message ?? `${response.status} ${response.statusText}`,
      response.status,
      body?.error?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** One typed call per route in `packages/server/src/app.ts`. */
export function createClient(token: string) {
  return {
    token,
    health: () => api<{ ok: boolean; version: string }>("/health", token),

    listProjects: () => api<{ projects: Project[] }>("/projects", token).then((body) => body.projects),
    createProject: (repoPath: string, name?: string) =>
      api<Project & { note?: string }>("/projects", token, {
        method: "POST",
        json: { repoPath, ...(name != null ? { name } : {}) },
      }),
    deleteProject: (id: string) => api<void>(`/projects/${id}`, token, { method: "DELETE" }),
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
    // directory, every other task diffs the project's working tree.
    listChanges: (threadId: string) => api<ChangesSnapshot>(`/threads/${threadId}/changes`, token),
    getFileDiff: (threadId: string, path: string) =>
      api<FileDiff>(`/threads/${threadId}/changes/file?path=${encodeURIComponent(path)}`, token),
    revertFile: (threadId: string, path: string) =>
      api<{ path: string }>(`/threads/${threadId}/changes/revert`, token, { method: "POST", json: { path } }),

    /** 收口: what this task can do with its changes right now. */
    getIntegration: (threadId: string) => api<IntegrationStatus>(`/threads/${threadId}/integration`, token),
    /** 提交 / 开 PR / 带回主目录 / 全部丢弃. `message` is required for 提交 and for a dirty PR. */
    integrate: (threadId: string, action: IntegrateAction, message?: string) =>
      api<ThreadRecord>(`/threads/${threadId}/integrate`, token, {
        method: "POST",
        json: { action, ...(message != null ? { message } : {}) },
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

    listThreads: () => api<{ threads: ThreadSummary[] }>("/threads", token).then((body) => body.threads),
    createThread: (input: {
      projectId: string;
      title?: string;
      engine?: EngineId;
      model?: string;
      /** The model's「思考等级」; omitted leaves the engine's own default. */
      reasoningEffort?: string;
      /** `worktree` gives the task its own checkout; the default edits the project. */
      workspace?: WorkspaceMode;
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
        /** Agent / Plan for the next turn. Refused while the task is live. */
        mode?: ThreadMode;
        /** 归档 also reclaims the task's worktree; un-archiving restores it. */
        archived?: boolean;
      },
    ) => api<ThreadRecord>(`/threads/${id}`, token, { method: "PATCH", json: patch }),
    deleteThread: (id: string) => api<void>(`/threads/${id}`, token, { method: "DELETE" }),

    /** Snapshots a task's worktree and removes the directory; reversible. */
    reclaimWorkspace: (id: string) =>
      api<ThreadRecord>(`/threads/${id}/workspace/reclaim`, token, { method: "POST" }),
    restoreWorkspace: (id: string) =>
      api<ThreadRecord>(`/threads/${id}/workspace/restore`, token, { method: "POST" }),

    /**
     * 恢复到此处: put the working directory back to the snapshot taken before
     * `messageId` ran — or, for 撤销, to the `commit` a previous restore returned.
     * Only the files move; the conversation is never touched.
     */
    restoreCheckpoint: (threadId: string, target: { messageId: string } | { commit: string }) =>
      api<CheckpointRestore>(`/threads/${threadId}/checkpoints/restore`, token, { method: "POST", json: target }),

    /** What the project's worktree setup script printed, for the 终端 tab. */
    getSetupLog: (id: string) => api<SetupLog>(`/threads/${id}/workspace/setup-log`, token),

    /** 计划文档: the Plan turn's product, which the user edits before Build. Empty content = none yet. */
    getPlan: (threadId: string) => api<PlanDocument>(`/threads/${threadId}/plan`, token),
    putPlan: (threadId: string, content: string) =>
      api<PlanDocument>(`/threads/${threadId}/plan`, token, { method: "PUT", json: { content } }),

    /** `/compact`: replaces the task's whole history with a summary of it. Vgent engine only. */
    compactThread: (id: string) => api<ThreadRecord>(`/threads/${id}/compact`, token, { method: "POST" }),

    /** 引擎能力表: what exists, what it is called, what it can do. */
    listEngines: () => api<{ engines: EngineDescriptor[] }>("/engines", token).then((body) => body.engines),

    /** The engine's model list. `refresh` skips the server's 10-minute cache. */
    listModels: (engine: EngineId, refresh = false) =>
      api<ModelCatalog>(`/engines/${engine}/models${refresh ? "?refresh=1" : ""}`, token),

    getSettings: () => api<Settings>("/settings", token),
    putSettings: (patch: Partial<Settings>) => api<Settings>("/settings", token, { method: "PUT", json: patch }),

    /**
     * 「一直允许」 on an approval card: one tool onto the global allowlist, right
     * now — it is clicked mid-turn, so it cannot go through the settings draft.
     * Taking one back off is an ordinary settings edit (`putSettings`).
     */
    allowTool: (tool: string) => api<Settings>("/settings/allowlist", token, { method: "POST", json: { tool } }),

    stopChat: (threadId: string) => api<void>(`/chat/${threadId}/stop`, token, { method: "POST" }),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
