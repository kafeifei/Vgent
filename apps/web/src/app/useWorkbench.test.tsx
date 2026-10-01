import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/lib/toast";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import type { Project, Settings, ThreadStatus, ThreadSummary } from "@/lib/types";
import { useWorkbench, type Workbench } from "./useWorkbench";

/** `EventSource`, driven by the test. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {}
  push(payload: unknown): void {
    for (const listener of this.listeners.get("state") ?? []) listener({ data: JSON.stringify(payload) });
  }
}

const NOON = "2026-01-01T12:00:00.000Z";
const at = (n: number): string => new Date(Date.parse(NOON) + n * 1000).toISOString();

const thread = (id: string, status: ThreadStatus = "idle", updatedAt = NOON, extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    version: 1,
    id,
    projectId: "p1",
    title: `任务 ${id}`,
    engine: "claude-code",
    status,
    createdAt: NOON,
    updatedAt,
    messageCount: 1,
    pendingApprovals: 0,
    ...extra,
  }) as ThreadSummary;

const project = { id: "p1", name: "vgent", repoPath: "/repo", createdAt: NOON } as Project;
const settings = { defaultEngine: "claude-code", runMode: "allow-reads", allowlist: [] } as unknown as Settings;

interface Answer {
  status?: number;
  body?: unknown;
  /** Resolves when the server finally answers. */
  after?: Promise<void>;
}

/** `fetch` for the workbench: what each `METHOD /path` answers, and a log of what was asked. */
function server() {
  const answers = new Map<string, Answer | (() => Answer)>();
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/^\/api/, "");
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`;
      asked.push(key);
      const found = answers.get(key);
      const answer = typeof found === "function" ? found() : found;
      if (answer?.after != null) await answer.after;
      if (answer?.status === 204) return new Response(null, { status: 204 });
      if (answer == null) {
        if (url === "/engines") return Response.json({ engines: [] });
        if (url.endsWith("/changes")) return Response.json({ repoPath: "/repo", branch: "main", files: [] });
        if (url.endsWith("/integration")) return Response.json({ commitsAhead: 0 });
        if (url.endsWith("/stream")) return new Response(null, { status: 204 });
        return Response.json({ id: url.split("/")[2], messages: [], updatedAt: NOON });
      }
      return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
    }),
  );
  return { answers, asked };
}

const refusal = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });

const trees: Tree[] = [];
let location: { search: string; pathname: string };
let sync: () => Promise<void>;

beforeEach(() => {
  FakeEventSource.instances = [];
  location = { search: "", pathname: "/" };
  const window = new EventTarget();
  Object.assign(window, { location, history: { replaceState: vi.fn() }, innerWidth: 1280, innerHeight: 800, event: undefined });
  vi.stubGlobal("window", window);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});

afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
  vi.unstubAllGlobals();
});

/** The workbench under a toast provider, fed by pushing snapshots the way the server does. */
async function mount(snapshot: { threads: ThreadSummary[]; projects?: Project[] } = { threads: [] }) {
  let current!: Workbench;
  const renders: Workbench[] = [];
  function Probe() {
    current = useWorkbench("tok");
    renders.push(current);
    return null;
  }
  const tree = await renderTree(createElement(ToastProvider, null, createElement(Probe)));
  trees.push(tree);
  const push = (next: { threads: ThreadSummary[]; projects?: Project[]; settings?: Settings }) =>
    tree.act(() => FakeEventSource.instances.at(-1)?.push({ projects: [project], settings, ...next }));
  sync = () => tree.act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  await push(snapshot);
  return { tree, push, now: () => current, renders, toasts: () => tree.byRole("status").map((node) => node.textContent) };
}

describe("the workbench's actions", () => {
  it("are one object for as long as the workbench lives, whatever the server pushes", async () => {
    server();
    const bench = await mount({ threads: [thread("t1"), thread("t2")] });
    const actions = bench.now().actions;

    await bench.push({ threads: [thread("t1", "running", at(5)), thread("t2")] });
    await bench.push({ threads: [thread("t1", "running", at(6)), thread("t2"), thread("t3")] });
    await bench.now().actions.selectThread("t1");
    await bench.tree.act(() => undefined);
    expect(bench.now().actions).toBe(actions);
  });

  it("keep every task that did not change as it was, so the list around a streaming task holds still", async () => {
    server();
    const bench = await mount({ threads: [thread("t1", "running", at(1)), thread("t2"), thread("t3")] });
    const before = bench.now().state.threads;

    await bench.push({ threads: [thread("t1", "running", at(2)), thread("t2"), thread("t3")] });
    const after = bench.now().state.threads;
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);

    // Nothing at all changed: the same list, the same visible list.
    const visible = bench.now().visibleThreads;
    await bench.push({ threads: [thread("t1", "running", at(2)), thread("t2"), thread("t3")] });
    expect(bench.now().state.threads).toBe(after);
    expect(bench.now().visibleThreads).toBe(visible);
  });
});

describe("删除任务", () => {
  it("leaves the reader where they are when they opened another task while the delete was on its way", async () => {
    const remote = server();
    let finish!: () => void;
    remote.answers.set("DELETE /threads/t1", { status: 204, after: new Promise<void>((resolve) => (finish = resolve)) });
    const bench = await mount({ threads: [thread("t1"), thread("t2")] });

    await bench.tree.act(() => bench.now().actions.selectThread("t1"));
    expect(bench.now().selectedThreadId).toBe("t1");
    await bench.tree.act(() => bench.now().actions.deleteThread("t1"));
    // The request is slow; meanwhile t2 is opened.
    await bench.tree.act(() => bench.now().actions.selectThread("t2"));
    await bench.tree.act(() => finish());
    await sync();

    expect(remote.asked).toContain("DELETE /threads/t1");
    expect(bench.now().selectedThreadId).toBe("t2");
    expect(bench.now().view).toBe("thread");
    expect(bench.toasts()).toEqual(["已删除任务"]);
  });

  it("goes back to the empty state when the deleted task is still the one on screen", async () => {
    const remote = server();
    remote.answers.set("DELETE /threads/t1", { status: 204 });
    const bench = await mount({ threads: [thread("t1"), thread("t2")] });
    await bench.tree.act(() => bench.now().actions.selectThread("t1"));
    await bench.tree.act(() => bench.now().actions.deleteThread("t1"));
    await sync();
    expect(bench.now().selectedThreadId).toBeNull();
    expect(bench.now().view).toBe("empty");
  });

  it("says why when the server refuses, and changes nothing", async () => {
    const remote = server();
    remote.answers.set("DELETE /threads/t1", refusal(409, "thread_transitioning", "任务正在归档，稍等"));
    const bench = await mount({ threads: [thread("t1")] });
    await bench.tree.act(() => bench.now().actions.selectThread("t1"));
    await bench.tree.act(() => bench.now().actions.deleteThread("t1"));
    await sync();
    expect(bench.now().selectedThreadId).toBe("t1");
    expect(bench.toasts()).toEqual(["任务正在归档，稍等"]);
  });
});

describe("a send that 停止 got to first (turn_start_cancelled)", () => {
  const cancelled = refusal(409, "turn_start_cancelled", "回合还没开始就被停止了，这条消息没有发出");

  it("is not reported when it was 「发送」 on the queue, Build, or a compaction that a harness runs as a turn", async () => {
    const remote = server();
    remote.answers.set("POST /threads/t1/queue/q1/send", cancelled);
    remote.answers.set("POST /threads/t1/compact", cancelled);
    remote.answers.set("PATCH /threads/t1", { body: { id: "t1", messages: [] } });
    remote.answers.set("POST /chat/t1", cancelled);
    const bench = await mount({ threads: [thread("t1")] });
    await bench.tree.act(async () => {
      await bench.now().actions.sendQueued("t1", "q1");
      await bench.now().actions.compactThread("t1");
      await bench.now().actions.buildFromPlan("t1", "# 计划");
    });
    await sync();
    expect(remote.asked).toEqual(expect.arrayContaining(["POST /threads/t1/queue/q1/send", "POST /threads/t1/compact", "POST /chat/t1"]));
    expect(bench.toasts()).toEqual([]);
  });

  it("is not reported when it was the first message of a task either — the text goes back to that task's draft", async () => {
    const remote = server();
    remote.answers.set("POST /threads", { body: { id: "t9", projectId: "p1", title: "新任务", engine: "claude-code", status: "idle", createdAt: NOON, updatedAt: NOON, messages: [] } });
    remote.answers.set("POST /chat/t9", cancelled);
    remote.answers.set("PUT /drafts/t9", { body: { text: "", attachments: [] } });
    const bench = await mount({ threads: [] });
    let started: boolean | undefined;
    await bench.tree.act(async () => {
      started = await bench.now().actions.startThread("先做这个", "claude-code", "project", null, null, "agent");
    });
    await sync();
    // The task exists and is open; its first message did not go out, and is kept as its draft.
    expect(started).toBe(true);
    expect(remote.asked).toContain("PUT /drafts/t9");
    expect(bench.toasts()).toEqual([]);
    expect(bench.now().failedFirstSend).toBe("t9");
  });

  it("still reports any other refusal on those paths, in the server's own words", async () => {
    const remote = server();
    remote.answers.set("POST /threads/t1/queue/q1/send", refusal(409, "thread_running", "任务还在进行中（等待审批或回答），先处理或停止"));
    remote.answers.set("POST /threads/t1/compact", refusal(409, "compact_running", "正在压缩，稍等"));
    const bench = await mount({ threads: [thread("t1")] });
    await bench.tree.act(async () => {
      await bench.now().actions.sendQueued("t1", "q1");
    });
    expect(bench.toasts()).toEqual(["任务还在进行中（等待审批或回答），先处理或停止"]);
    await bench.tree.act(async () => {
      await bench.now().actions.compactThread("t1");
    });
    expect(bench.toasts()).toEqual(["正在压缩，稍等"]);
  });
});
