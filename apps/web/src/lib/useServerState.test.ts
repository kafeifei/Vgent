import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_TIMEOUT_MS, UNAUTHORIZED_EVENT } from "./api";
import { renderHook, type HookHandle } from "./testing/renderHook";
import type { Project, Settings, ThreadSummary } from "./types";
import { useServerState, type ServerState } from "./useServerState";

/** `EventSource`, driven by the test: it opens nothing and only does what it is told. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  push(payload: unknown): void {
    for (const listener of this.listeners.get("state") ?? []) listener({ data: JSON.stringify(payload) });
  }

  fail(): void {
    this.onerror?.();
  }
}

const sources = () => FakeEventSource.instances;

const thread = (id: string, title = id): ThreadSummary =>
  ({
    version: 1,
    id,
    projectId: "p1",
    title,
    engine: "claude-code",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    pendingApprovals: 0,
  }) as ThreadSummary;

const project = { id: "p1", name: "vgent", repoPath: "/repo", createdAt: "2026-01-01T00:00:00.000Z" } as Project;
const settings = { defaultEngine: "claude-code", runMode: "allow-reads", allowlist: ["read"] } as Settings;
const snapshot = (threads: ThreadSummary[]) => ({ projects: [project], threads, settings });

/** What `probeToken` will hear from the server: a status, `"hang"` (never answers) or `"down"` (cannot connect). */
let probe: number | "hang" | "down";
let probes: number;
let storage: Map<string, string>;
const handles: Array<HookHandle<ServerState, string>> = [];

async function mount(token = "tok", onRender?: () => void) {
  const hook = await renderHook(
    (current: string) => {
      onRender?.();
      return useServerState(current);
    },
    { props: token },
  );
  handles.push(hook);
  return hook;
}

beforeEach(() => {
  // Only the two timers the hook and the probe use; React's own scheduling stays real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  FakeEventSource.instances = [];
  probe = 200;
  probes = 0;
  storage = new Map([["vgent.token", "tok"]]);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      probes += 1;
      if (probe === "down") return Promise.reject(new TypeError("Failed to fetch"));
      if (probe === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(null, { status: probe as number }));
    }),
  );
});

afterEach(async () => {
  for (const hook of handles.splice(0)) await hook.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useServerState 快照", () => {
  it("connects with the token, and is not connected until the first state arrives", async () => {
    const hook = await mount("s3cret token");
    expect(sources()).toHaveLength(1);
    expect(sources()[0]?.url).toBe("/api/state?token=s3cret%20token");
    expect(hook.result.current).toEqual({ projects: [], threads: [], settings: null, connected: false });

    await hook.act(() => sources()[0]?.push(snapshot([thread("a")])));
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.threads.map((entry) => entry.id)).toEqual(["a"]);
    expect(hook.result.current.settings).toEqual(settings);
  });

  it("keeps the identity of everything a push did not change, and hands back the very same state for an identical one", async () => {
    let renders = 0;
    const hook = await mount("tok", () => {
      renders += 1;
    });
    await hook.act(() => sources()[0]?.push(snapshot([thread("a"), thread("b")])));
    const first = hook.result.current;
    const rendered = renders;

    // The same content, freshly parsed, as the server pushes it whenever anything changes.
    for (let push = 0; push < 3; push++) {
      await hook.act(() => sources()[0]?.push(snapshot([thread("a"), thread("b")])));
      expect(hook.result.current).toBe(first);
    }
    // React may call the hook once more to find out that nothing changed; it commits nothing.
    expect(renders - rendered).toBeLessThanOrEqual(1);

    // One task changed: that one is new, its neighbour and the other lists are not.
    await hook.act(() => sources()[0]?.push(snapshot([thread("a"), thread("b", "改名了")])));
    const next = hook.result.current;
    expect(next.threads[1]?.title).toBe("改名了");
    expect(next.threads[0]).toBe(first.threads[0]);
    expect(next.projects).toBe(first.projects);
    expect(next.settings).toBe(first.settings);
  });
});

describe("useServerState 重连退避", () => {
  const delays = async (hook: HookHandle<ServerState, string>, expected: number[]) => {
    for (const wait of expected) {
      const before = sources().length;
      await hook.act(() => sources().at(-1)?.fail());
      await vi.advanceTimersByTimeAsync(0);
      // Not a moment early…
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(sources()).toHaveLength(before);
      // …and then exactly one new attempt.
      await vi.advanceTimersByTimeAsync(1);
      expect(sources()).toHaveLength(before + 1);
    }
  };

  it("doubles the wait after every failed attempt, up to 8 s", async () => {
    const hook = await mount();
    await delays(hook, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
    // Every attempt but the live one was closed, so none is left reconnecting on its own.
    expect(sources().slice(0, -1).every((source) => source.closed)).toBe(true);
  });

  it("starts over at 500 ms once a connection has actually delivered state", async () => {
    const hook = await mount();
    await delays(hook, [500, 1000, 2000]);
    await hook.act(() => sources().at(-1)?.push(snapshot([thread("a")])));
    await delays(hook, [500, 1000]);
  });

  it("marks the connection lost at once, and connected again with the next state", async () => {
    const hook = await mount();
    await hook.act(() => sources()[0]?.push(snapshot([thread("a")])));
    expect(hook.result.current.connected).toBe(true);
    await hook.act(() => sources()[0]?.fail());
    expect(hook.result.current.connected).toBe(false);
    // What was on screen stays: a drop is not an empty server.
    expect(hook.result.current.threads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    await hook.act(() => sources()[1]?.push(snapshot([thread("a"), thread("b")])));
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.threads).toHaveLength(2);
  });

  it("treats a probe that cannot reach the server as one more drop and keeps trying", async () => {
    probe = "down";
    const hook = await mount();
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(500);
    expect(sources()).toHaveLength(2);
    expect(storage.has("vgent.token")).toBe(true);
  });

  it("does not wait forever on a probe the server never answers: after the timeout it retries", async () => {
    probe = "hang";
    const hook = await mount();
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(sources()).toHaveLength(1);
    // The probe gives up here, and the (500 ms) backoff starts from there.
    await vi.advanceTimersByTimeAsync(1);
    expect(sources()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(sources()).toHaveLength(2);
  });
});

describe("useServerState 401", () => {
  it("stops for good when the probe says the token was rejected: token dropped, app told once, no retry", async () => {
    probe = 401;
    const hook = await mount();
    let unauthorized = 0;
    window.addEventListener(UNAUTHORIZED_EVENT, () => (unauthorized += 1));
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(0);
    expect(unauthorized).toBe(1);
    expect(storage.has("vgent.token")).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sources()).toHaveLength(1);
    expect(probes).toBe(1);
    // A late error from the dead source does not start it all over.
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sources()).toHaveLength(1);
    expect(unauthorized).toBe(1);
  });
});

describe("useServerState 清理", () => {
  it("closes the source and cancels a pending retry on unmount", async () => {
    const hook = await mount();
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await hook.unmount();
    expect(sources()[0]?.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources()).toHaveLength(1);
  });

  it("closes the live source on unmount", async () => {
    const hook = await mount();
    await hook.unmount();
    expect(sources()[0]?.closed).toBe(true);
  });

  it("ignores a probe that answers after the hook is gone", async () => {
    probe = "hang";
    const hook = await mount();
    await hook.act(() => sources()[0]?.fail());
    await hook.unmount();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 60_000);
    expect(sources()).toHaveLength(1);
  });

  it("closes a superseded source's late error instead of letting it reconnect on its own", async () => {
    const hook = await mount();
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(500);
    expect(sources()).toHaveLength(2);

    // The first source errors again after the second took over.
    await hook.act(() => sources()[0]?.fail());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources()).toHaveLength(2);
    expect(sources()[1]?.closed).toBe(false);
  });

  it("reconnects with the new token, and the old source goes", async () => {
    const hook = await mount("one");
    await hook.rerender("two");
    expect(sources()).toHaveLength(2);
    expect(sources()[0]?.closed).toBe(true);
    expect(sources()[1]?.url).toBe("/api/state?token=two");
  });
});
