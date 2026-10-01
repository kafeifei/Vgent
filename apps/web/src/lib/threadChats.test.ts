import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { ThreadChats, transportErrorText } from "./threadChats";
import type { ThreadRecord, ThreadStatus, ThreadSummary } from "./types";

const THREAD_ID = "t1";

const message = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

const record = (updatedAt: string, messages: UIMessage[]): ThreadRecord => ({
  version: 1,
  id: THREAD_ID,
  projectId: "p1",
  title: "t",
  engine: "claude-code",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt,
  messages,
});

const summary = (status: ThreadStatus, updatedAt: string, messageCount: number): ThreadSummary => ({
  ...record(updatedAt, []),
  status,
  messageCount,
  pendingApprovals: 0,
});

/** The server, as a `fetch` that logs what the registry asks it for. */
function server(options: { history: () => Promise<ThreadRecord> }) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/stream")) return new Response(null, { status: 204 });
    const body = await options.history();
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const historyCalls = (calls: readonly string[]) => calls.filter((url) => url.includes("/api/threads/"));
const streamCalls = (calls: readonly string[]) => calls.filter((url) => url.endsWith("/stream"));

let chats: ThreadChats;
const errors: Error[] = [];

beforeEach(() => {
  errors.length = 0;
  chats = new ThreadChats("token", (error) => errors.push(error));
});

afterEach(() => {
  chats.dispose();
  vi.unstubAllGlobals();
});

describe("ThreadChats hydration and resume", () => {
  it("resumes only after the history is in the chat", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = server({
      history: async () => {
        await gate;
        return record("2026-01-01T00:00:01.000Z", [message("m1")]);
      },
    });

    chats.observeThreads([summary("running", "2026-01-01T00:00:01.000Z", 1)]);
    chats.focus(THREAD_ID);
    const chat = chats.get(THREAD_ID);
    const ready = chats.whenReady(THREAD_ID);

    // The history is still in flight: nothing may have attached to the stream.
    await Promise.resolve();
    expect(streamCalls(calls)).toHaveLength(0);
    expect(chat.messages).toHaveLength(0);

    release?.();
    await ready;
    await vi.waitFor(() => expect(streamCalls(calls)).toHaveLength(1));
    expect(chat.messages).toHaveLength(1);
    expect(calls.indexOf(calls.find((url) => url.endsWith("/stream")) as string)).toBeGreaterThan(0);
    expect(errors).toHaveLength(0);
  });

  it("does not resume twice when a snapshot lands while the history loads", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = server({
      history: async () => {
        await gate;
        return record("2026-01-01T00:00:01.000Z", [message("m1")]);
      },
    });

    const live = summary("running", "2026-01-01T00:00:01.000Z", 1);
    chats.observeThreads([live]);
    chats.focus(THREAD_ID);
    chats.get(THREAD_ID);
    // Snapshots keep arriving while the history is in flight.
    chats.observeThreads([live]);
    chats.observeThreads([live]);

    release?.();
    await chats.whenReady(THREAD_ID);
    await vi.waitFor(() => expect(streamCalls(calls)).toHaveLength(1));

    // And a later snapshot for a thread that is now idle must not resume again.
    chats.observeThreads([summary("idle", "2026-01-01T00:00:01.000Z", 1)]);
    await vi.waitFor(() => expect(historyCalls(calls)).toHaveLength(1));
    expect(streamCalls(calls)).toHaveLength(1);
  });

  it("refreshes the snapshot when updatedAt advances with an unchanged count", async () => {
    let current = record("2026-01-01T00:00:01.000Z", [message("m1")]);
    const { calls } = server({ history: async () => current });

    const chat = chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    expect(historyCalls(calls)).toHaveLength(1);

    // Same `updatedAt`: nothing to re-read.
    chats.observeThreads([summary("idle", "2026-01-01T00:00:01.000Z", 1)]);
    await Promise.resolve();
    expect(historyCalls(calls)).toHaveLength(1);

    // The turn ended in an error: same message count, newer record.
    current = record("2026-01-01T00:00:09.000Z", [message("m1-fixed")]);
    chats.observeThreads([summary("error", "2026-01-01T00:00:09.000Z", 1)]);
    await vi.waitFor(() => expect(chat.messages.map((entry) => entry.id)).toEqual(["m1-fixed"]));
    expect(historyCalls(calls)).toHaveLength(2);
    expect(streamCalls(calls)).toHaveLength(0);
  });
});

describe("ThreadChats streams only the task on screen", () => {
  /**
   * The server with a turn in flight: `/stream` answers an open SSE body that
   * stays open until the test ends, and reports when the client lets go of it.
   */
  function liveServer(options: { history: () => ThreadRecord; chat?: () => Response }) {
    const calls: string[] = [];
    const released: string[] = [];
    const openStream = (url: string, signal: AbortSignal | null | undefined) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "start", messageId: "a1" })}\n\n`));
        },
        cancel() {
          released.push(url);
        },
      });
      signal?.addEventListener("abort", () => released.push(url));
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
        if (url.endsWith("/stream")) return openStream(url, init?.signal);
        if (url.includes("/api/chat/")) return options.chat?.() ?? openStream(url, init?.signal);
        return new Response(JSON.stringify(options.history()), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return { calls, released };
  }

  it("never opens a stream for a running task that is not on screen", async () => {
    const { calls } = liveServer({ history: () => record("2026-01-01T00:00:01.000Z", [message("m1")]) });

    chats.observeThreads([summary("running", "2026-01-01T00:00:01.000Z", 1)]);
    chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    chats.observeThreads([summary("running", "2026-01-01T00:00:02.000Z", 1)]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(streamCalls(calls)).toHaveLength(0);
    expect(chats.peek(THREAD_ID)).toBeUndefined();
  });

  it("lets go of the stream when the task is left, and joins again with a fresh history on return", async () => {
    let current = record("2026-01-01T00:00:01.000Z", [message("m1")]);
    const { calls, released } = liveServer({ history: () => current });

    chats.observeThreads([summary("running", "2026-01-01T00:00:01.000Z", 1)]);
    chats.focus(THREAD_ID);
    const chat = chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    await vi.waitFor(() => expect(streamCalls(calls)).toHaveLength(1));

    chats.focus(null);
    await vi.waitFor(() => expect(released).toHaveLength(1));
    await vi.waitFor(() => expect(chat.status).toBe("ready"));

    // The turn went on without us: the record has moved on by the time we return.
    current = record("2026-01-01T00:00:05.000Z", [message("m1"), message("m2")]);
    chats.observeThreads([summary("running", "2026-01-01T00:00:05.000Z", 2)]);
    expect(streamCalls(calls)).toHaveLength(1);

    chats.focus(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    expect(chat.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
    await vi.waitFor(() => expect(streamCalls(calls)).toHaveLength(2));
    expect(errors).toHaveLength(0);
  });

  it("lets go of a send once the server took it, when its task is no longer on screen", async () => {
    const { calls, released } = liveServer({ history: () => record("2026-01-01T00:00:01.000Z", [message("m1")]) });

    chats.focus(THREAD_ID);
    chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    // Left before the server answered — a new task whose worktree took a while.
    const sent = chats.send(THREAD_ID, "发出去了");
    chats.focus("elsewhere");
    await expect(sent).resolves.toBeUndefined();

    await vi.waitFor(() => expect(released.filter((url) => url.endsWith(`/api/chat/${THREAD_ID}`))).toHaveLength(1));
    // Cut off mid-turn, the chat must not post its partial state again.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((url) => url.startsWith("POST "))).toHaveLength(1);
  });
});

describe("ThreadChats send", () => {
  /** The chat route answers `chat`; everything else is the thread's history. */
  function chatServer(chat: () => Response): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/chat/")) return chat();
        return new Response(JSON.stringify(record("2026-01-01T00:00:01.000Z", [message("m1")])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  it("rejects when the server refuses the message, and takes the optimistic one back out", async () => {
    const refused = "任务还在进行中（等待审批或回答），先处理或停止";
    chatServer(
      () =>
        new Response(JSON.stringify({ error: { code: "thread_running", message: refused } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );

    const chat = chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);

    // 草稿任何情况下不丢: the composer is only cleared when this resolves.
    await expect(chats.send(THREAD_ID, "别把我吞了")).rejects.toThrow();
    // The message never went out, so it may not sit in the log either.
    expect(chat.messages.map((entry) => entry.id)).toEqual(["m1"]);
    await vi.waitFor(() => expect(errors.map((error) => error.message)).toContain(refused));
  });

  it("resolves as soon as the server accepted it, long before the turn ends", async () => {
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
    });
    chatServer(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));

    const chat = chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);

    // The stream is still open — 被接受 is all the composer waits for.
    await expect(chats.send(THREAD_ID, "发出去了")).resolves.toBeUndefined();
    expect(chat.messages).toHaveLength(2);
    expect(errors).toHaveLength(0);
    close?.();
  });

  it("rejects when the connection itself fails", async () => {
    chatServer(() => {
      throw new TypeError("Failed to fetch");
    });

    chats.get(THREAD_ID);
    await chats.whenReady(THREAD_ID);
    await expect(chats.send(THREAD_ID, "server 关了")).rejects.toThrow();
  });
});

describe("transportErrorText", () => {
  it("shows the server's own message instead of its JSON envelope", () => {
    const body = JSON.stringify({ error: { code: "invalid_messages", message: "消息格式不合法：第 2 条消息的 tool-read 一步" } });
    expect(transportErrorText(body)).toBe("消息格式不合法：第 2 条消息的 tool-read 一步");
    expect(transportErrorText("Failed to fetch")).toBe("Failed to fetch");
    expect(transportErrorText('{"unrelated":true}')).toBe('{"unrelated":true}');
  });
});

// --- 等人的任务：没有流可接的时候不反复去问 -----------------------------------------

const recordFor = (id: string, updatedAt: string, messages: UIMessage[] = []): ThreadRecord => ({ ...record(updatedAt, messages), id });

const summaryFor = (id: string, status: ThreadStatus, updatedAt: string): ThreadSummary => ({
  ...summary(status, updatedAt, 1),
  id,
});

/** `updatedAt` for the n-th update: a bigger n is a more recent one. */
const at = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/**
 * The server for several tasks. `GET /stream` answers 204 unless the task is
 * `serve`d, in which case it stays open — one held connection — until the
 * client aborts it or the test ends it.
 */
function world() {
  const calls: string[] = [];
  const records = new Map<string, ThreadRecord>();
  const serving = new Set<string>();
  const connections = new Map<string, { closed: boolean; end: () => void }>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const stream = /\/api\/chat\/([^/]+)\/stream$/.exec(url);
      if (stream != null) {
        const id = stream[1] as string;
        if (!serving.has(id)) return new Response(null, { status: 204 });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(started) {
            controller = started;
          },
        });
        const connection = {
          closed: false,
          end: () => {
            if (connection.closed) return;
            connection.closed = true;
            controller.close();
          },
        };
        connections.set(id, connection);
        init?.signal?.addEventListener("abort", () => connection.end());
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const history = /\/api\/threads\/([^/]+)$/.exec(url);
      if (history == null) throw new Error(`unexpected request ${url}`);
      const id = history[1] as string;
      return new Response(JSON.stringify(records.get(id) ?? recordFor(id, at(0))), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return {
    records,
    serving,
    streamCalls: (id: string) => calls.filter((url) => url.endsWith(`/api/chat/${id}/stream`)).length,
    historyCalls: (id: string) => calls.filter((url) => url.endsWith(`/api/threads/${id}`)).length,
    /** The tasks whose stream is open right now. */
    open: () => [...connections].filter(([, connection]) => !connection.closed).map(([id]) => id).sort(),
    end: (id: string) => connections.get(id)?.end(),
    /** Puts the task on screen the way the open view does, and waits for its history. */
    async show(id: string) {
      chats.focus(id);
      chats.get(id);
      await chats.whenReady(id);
    },
  };
}

/** Lets the fire-and-forget resumes and refreshes the registry kicked off run to their next await. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("ThreadChats and tasks waiting on the human", () => {
  it("does not go back to the server for every snapshot of a task that has nothing to join", async () => {
    const remote = world();
    remote.records.set("t1", recordFor("t1", at(10), [message("m1")]));
    const waiting = summaryFor("t1", "awaiting-approval", at(10));
    chats.observeThreads([waiting]);
    await remote.show("t1");
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(1));
    await settle();
    expect(remote.historyCalls("t1")).toBe(1);

    // The server pushes a state event for every change of anything; none of them touches this task.
    for (let push = 0; push < 5; push++) {
      chats.observeThreads([{ ...waiting }]);
      await settle();
    }
    expect(remote.streamCalls("t1")).toBe(1);
    expect(remote.historyCalls("t1")).toBe(1);
  });

  it("looks once more when the task really changed — one history read and one stream request, however often it is pushed", async () => {
    const remote = world();
    remote.records.set("t1", recordFor("t1", at(10), [message("m1")]));
    chats.observeThreads([summaryFor("t1", "awaiting-approval", at(10))]);
    await remote.show("t1");
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(1));

    remote.records.set("t1", recordFor("t1", at(20), [message("m1"), message("m2")]));
    for (let push = 0; push < 4; push++) {
      chats.observeThreads([summaryFor("t1", "awaiting-approval", at(20))]);
      await settle();
    }
    expect(remote.historyCalls("t1")).toBe(2);
    expect(remote.streamCalls("t1")).toBe(2);
    expect(chats.peek("t1")?.messages.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("asks a running task's stream endpoint once per update, too, when it has no stream yet", async () => {
    const remote = world();
    chats.observeThreads([summaryFor("t1", "running", at(10))]);
    await remote.show("t1");
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(1));
    for (let push = 0; push < 3; push++) {
      chats.observeThreads([summaryFor("t1", "running", at(10))]);
      await settle();
    }
    expect(remote.streamCalls("t1")).toBe(1);
    chats.observeThreads([summaryFor("t1", "running", at(11))]);
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(2));
  });

  it("asks once more when the task is opened again, however little it changed meanwhile", async () => {
    const remote = world();
    chats.observeThreads([summaryFor("t1", "awaiting-approval", at(10))]);
    await remote.show("t1");
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(1));

    chats.focus(null);
    chats.observeThreads([summaryFor("t1", "awaiting-approval", at(10))]);
    await settle();
    expect(remote.streamCalls("t1")).toBe(1);

    chats.focus("t1");
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(2));
  });

  it("still joins again after a stream that ran and then dropped, since that is not a 204", async () => {
    const remote = world();
    remote.serving.add("t1");
    chats.observeThreads([summaryFor("t1", "running", at(10))]);
    await remote.show("t1");
    await vi.waitFor(() => expect(remote.open()).toEqual(["t1"]));

    remote.end("t1");
    await vi.waitFor(() => expect(chats.peek("t1")?.status).toBe("ready"));
    chats.observeThreads([summaryFor("t1", "running", at(10))]);
    await vi.waitFor(() => expect(remote.streamCalls("t1")).toBe(2));
  });
});
