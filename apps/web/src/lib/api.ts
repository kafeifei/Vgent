import type {
  ChangesSnapshot,
  FileDiff,
  PermissionMode,
  Project,
  Settings,
  ThreadRecord,
  ThreadSummary,
} from "./types";

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
    throw new Error(UNAUTHORIZED_MESSAGE);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
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
      api<Project>("/projects", token, {
        method: "POST",
        json: { repoPath, ...(name != null ? { name } : {}) },
      }),
    deleteProject: (id: string) => api<void>(`/projects/${id}`, token, { method: "DELETE" }),

    listChanges: (projectId: string) => api<ChangesSnapshot>(`/projects/${projectId}/changes`, token),
    getFileDiff: (projectId: string, path: string) =>
      api<FileDiff>(`/projects/${projectId}/changes/file?path=${encodeURIComponent(path)}`, token),
    revertFile: (projectId: string, path: string) =>
      api<{ path: string }>(`/projects/${projectId}/changes/revert`, token, { method: "POST", json: { path } }),

    listThreads: () => api<{ threads: ThreadSummary[] }>("/threads", token).then((body) => body.threads),
    createThread: (input: { projectId: string; title?: string; permissionMode?: PermissionMode; model?: string }) =>
      api<ThreadRecord>("/threads", token, { method: "POST", json: input }),
    getThread: (id: string) => api<ThreadRecord>(`/threads/${id}`, token),
    patchThread: (id: string, patch: { title?: string; permissionMode?: PermissionMode; model?: string | null }) =>
      api<ThreadRecord>(`/threads/${id}`, token, { method: "PATCH", json: patch }),
    deleteThread: (id: string) => api<void>(`/threads/${id}`, token, { method: "DELETE" }),

    getSettings: () => api<Settings>("/settings", token),
    putSettings: (patch: Partial<Settings>) => api<Settings>("/settings", token, { method: "PUT", json: patch }),

    stopChat: (threadId: string) => api<void>(`/chat/${threadId}/stop`, token, { method: "POST" }),
  };
}

export type ApiClient = ReturnType<typeof createClient>;
