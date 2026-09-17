const TOKEN_KEY = "vgent.token";

/** Reads `#token=…` once on load, persists it, and strips it from the URL. */
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

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
