import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { ThreadChats } from "./threadChats";
import type { ThreadRecord, ThreadStatus, ThreadSummary } from "./types";

const THREAD_ID = "t1";

const message = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });

const record = (updatedAt: string, messages: UIMessage[]): ThreadRecord => ({
  version: 1,
  id: THREAD_ID,
  projectId: "p1",
  title: "t",
  engine: "claude-code",
  permissionMode: "allow-reads",
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
