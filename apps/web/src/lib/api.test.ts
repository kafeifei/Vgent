import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, PROBE_TIMEOUT_MS, TURN_START_CANCELLED, UNAUTHORIZED_EVENT, UNAUTHORIZED_MESSAGE, api, createClient, isTurnStartCancelled, probeToken, sseUrl } from "./api";

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** `fetch`, answering with whatever `respond` returns and remembering what it was asked. */
function stubFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

let storage: Map<string, string>;
let unauthorized: number;
const onUnauthorized = () => {
  unauthorized += 1;
};

beforeEach(() => {
  storage = new Map([["vgent.token", "stale-token"]]);
  unauthorized = 0;
  const window = new EventTarget();
  window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  vi.stubGlobal("window", window);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api", () => {
  it("sends the token, and a JSON body with its content type only when there is one", async () => {
    const calls = stubFetch(() => json({ ok: true }));
    await api("/health", "tok");
    await api("/threads", "tok", { method: "POST", json: { title: "任务" }, headers: { "x-extra": "1" } });

    expect(calls[0]?.url).toBe("/api/health");
    expect(calls[0]?.init?.headers).toEqual({ "x-vgent-token": "tok" });
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.headers).toEqual({ "x-vgent-token": "tok", "content-type": "application/json", "x-extra": "1" });
    expect(calls[1]?.init?.body).toBe('{"title":"任务"}');
  });

  it("parses a JSON answer, and answers undefined to a 204", async () => {
    stubFetch(() => json({ threads: [1, 2] }));
    await expect(api<{ threads: number[] }>("/threads", "tok")).resolves.toEqual({ threads: [1, 2] });
    stubFetch(() => new Response(null, { status: 204 }));
    await expect(api<void>("/threads/t1", "tok", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("turns the server's error envelope into an ApiError carrying status, code and details", async () => {
    const details = { conflicts: [{ path: "a.ts" }] };
    stubFetch(() => json({ error: { code: "apply_conflict", message: "有 1 个文件冲突", details } }, { status: 409, statusText: "Conflict" }));
    const failure = await api("/threads/t1/integrate", "tok", { method: "POST" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ name: "ApiError", message: "有 1 个文件冲突", status: 409, code: "apply_conflict", details });
    expect(unauthorized).toBe(0);
  });

  it("falls back to the status line when the body is not the envelope — plain text, another JSON, or empty", async () => {
    for (const body of [new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }), json({ unrelated: true }, { status: 502, statusText: "Bad Gateway" }), new Response(null, { status: 502, statusText: "Bad Gateway" })]) {
      stubFetch(() => body);
      const failure = (await api("/threads", "tok").catch((error: unknown) => error)) as ApiError;
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure.message).toBe("502 Bad Gateway");
      expect(failure.status).toBe(502);
      expect(failure.code).toBeUndefined();
      expect(failure.details).toBeUndefined();
    }
  });

  it("a 401 drops the token, tells the app once, and never reads the body as an ordinary failure", async () => {
    stubFetch(() => json({ error: { code: "whatever", message: "别的说法" } }, { status: 401 }));
    const failure = (await api("/threads", "tok").catch((error: unknown) => error)) as ApiError;
    expect(failure).toMatchObject({ message: UNAUTHORIZED_MESSAGE, status: 401, code: "unauthorized" });
    expect(storage.has("vgent.token")).toBe(false);
    expect(unauthorized).toBe(1);
  });

  it("lets a network failure through as it is, without touching the token", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(api("/threads", "tok")).rejects.toThrow("Failed to fetch");
    expect(storage.has("vgent.token")).toBe(true);
    expect(unauthorized).toBe(0);
  });
});

describe("createClient", () => {
  it("reads the uncommitted count and marks a leaving page's draft write keepalive", async () => {
    const calls = stubFetch(({ url }) => (url.includes("uncommitted") ? json({ files: 3 }) : json({ text: "", attachments: [] })));
    const client = createClient("tok");
    await expect(client.uncommittedFiles("t1")).resolves.toBe(3);
    expect(calls[0]?.url).toBe("/api/threads/t1/workspace/uncommitted");

    await client.putDraft("t1", { text: "hi", attachments: [] }, { keepalive: true });
    expect(calls[1]?.url).toBe("/api/drafts/t1");
    expect(calls[1]?.init).toMatchObject({ method: "PUT", keepalive: true });
  });

  it("gives a file the same error mapping, 401 included", async () => {
    stubFetch(() => json({ error: { code: "file_too_large", message: "文件太大，无法预览: a.bin" } }, { status: 400 }));
    const client = createClient("tok");
    await expect(client.getFileBlob("t1", "a.bin")).rejects.toMatchObject({ status: 400, code: "file_too_large", message: "文件太大，无法预览: a.bin" });

    stubFetch(() => new Response(null, { status: 401 }));
    await expect(client.getFileBlob("t1", "a.bin")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(unauthorized).toBe(1);
  });

  it("takes one tool off the allowlist by its name, escaped into the path", async () => {
    const calls = stubFetch(() => json({ allowlist: [] }));
    const client = createClient("tok");
    await client.disallowTool("bash(cat /etc/hosts)");
    expect(calls[0]?.url).toBe("/api/settings/allowlist/bash(cat%20%2Fetc%2Fhosts)");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  it("builds the SSE url with the token escaped, since EventSource cannot send headers", () => {
    expect(sseUrl("/api/state", "a b&c")).toBe("/api/state?token=a%20b%26c");
  });
});

describe("probeToken", () => {
  it("says whether the token still works — only a 401 means it does not", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(probeToken("tok")).resolves.toBe(true);
    stubFetch(() => new Response(null, { status: 500 }));
    await expect(probeToken("tok")).resolves.toBe(true);
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(probeToken("tok")).resolves.toBe(false);
    // Asking is not being rejected: it must not drop the token by itself.
    expect(unauthorized).toBe(0);
  });

  it("gives up on a server that never answers, instead of leaving the reconnect waiting forever", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );

    const outcome = probeToken("tok").then(
      () => "answered",
      (error: unknown) => (error as Error).name,
    );
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave its timer behind once the server has answered", async () => {
    vi.useFakeTimers();
    stubFetch(() => new Response(null, { status: 200 }));
    await probeToken("tok");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isTurnStartCancelled", () => {
  it("knows the server's answer to a message whose turn 停止 got to first — by its code", async () => {
    stubFetch(() => json({ error: { code: TURN_START_CANCELLED, message: "回合还没开始就被停止了，这条消息没有发出" } }, { status: 409 }));
    const failure = await api("/threads/t1/queue/q1/send", "tok", { method: "POST" }).catch((error: unknown) => error);
    expect(isTurnStartCancelled(failure)).toBe(true);
    expect(isTurnStartCancelled(new ApiError("x", 409, TURN_START_CANCELLED))).toBe(true);
  });

  it("is false for every other failure", () => {
    expect(isTurnStartCancelled(new ApiError("正在压缩上下文，压完再发", 409, "thread_compacting"))).toBe(false);
    expect(isTurnStartCancelled(new ApiError("服务正在退出", 409, "server_stopping"))).toBe(false);
    expect(isTurnStartCancelled(new ApiError("x", 409))).toBe(false);
    expect(isTurnStartCancelled(new Error(TURN_START_CANCELLED))).toBe(false);
    expect(isTurnStartCancelled(undefined)).toBe(false);
  });
});
