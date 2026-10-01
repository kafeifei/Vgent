import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexNotification } from "./codex-app-server.js";
import type { EngineContext } from "./registry.js";
import { createNativeCodexRunner } from "./codex-native.js";

const protocol = vi.hoisted(() => ({
  notify: undefined as ((event: CodexNotification) => void) | undefined,
  request: vi.fn(), start: vi.fn(), dispose: vi.fn(), failInitialize: false,
}));
beforeEach(() => { vi.clearAllMocks(); protocol.failInitialize = false; });

// Exercise the real event adapter without spawning a CLI or touching its home.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), mkdir: vi.fn(async () => undefined) }));
vi.mock("@vgent/engines", async (original) => ({ ...await original<typeof import("@vgent/engines")>(), prepareCodexHome: async () => "/fixture-home" }));
vi.mock("@vgent/providers", async (original) => ({ ...await original<typeof import("@vgent/providers")>(), getCodexTokenProvider: () => ({ getAccessToken: async () => ({ accessToken: "fixture" }) }) }));
vi.mock("../codex-catalog.js", () => ({ prepareCodexSpeedCatalog: async () => ({ path: "/fixture-catalog.json", dispose: protocol.dispose }) }));
vi.mock("./codex-app-server.js", () => ({
  CodexAppServer: class {
    constructor(options: unknown) { protocol.start(options); }
    async initialize() { if (protocol.failInitialize) throw new Error("init failed"); }
    async request(method: string, params: unknown) {
      protocol.request(method, params);
      return method === "thread/start" ? { thread: { id: "thread" } } : { turn: { id: "turn" } };
    }
    onNotification(callback: (event: CodexNotification) => void) { protocol.notify = callback; return () => { protocol.notify = undefined; }; }
    async close() {}
  },
}));

describe("native speed configuration", () => {
  const context = () => ({ project: { repoPath: "/fixture" }, thread: { id: "fixture" }, saveHarnessState: vi.fn() }) as unknown as EngineContext;
  it.each(["ultrafast", undefined])("forwards %s or explicitly clears a resumed tier", async (serviceTier) => {
    const runner = await createNativeCodexRunner(context(), { model: "gpt-6-astra", ...(serviceTier != null ? { serviceTier } : {}) });
    await runner.stream({ messages: [{ role: "user", content: "OK" }], abortSignal: new AbortController().signal });
    expect(protocol.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ serviceTier: serviceTier ?? null }));
    if (serviceTier != null) expect(protocol.start).toHaveBeenCalledWith(expect.objectContaining({ modelCatalogPath: "/fixture-catalog.json" }));
    else expect(protocol.start.mock.calls[0]?.[0]).not.toHaveProperty("modelCatalogPath");
    await runner.finish();
    await runner.destroy();
    expect(protocol.dispose).toHaveBeenCalledTimes(serviceTier == null ? 0 : 1);
  });
  it("disposes the catalog when startup fails", async () => {
    protocol.failInitialize = true;
    await expect(createNativeCodexRunner(context(), { model: "gpt-6-astra", serviceTier: "ultrafast" })).rejects.toThrow("init failed");
    expect(protocol.dispose).toHaveBeenCalledOnce();
  });
});

describe("native Codex command classification", () => {
  it.each([
    { actions: [{ type: "read", command: "cat a.ts", path: "/repo/a.ts", name: "a.ts" }, { type: "search", command: "rg x", query: "x", path: null }] },
    { actions: [{ type: "unknown", command: "node script.js" }] },
    { actions: undefined },
  ])("preserves the native actions through streaming and the completed result: $actions", async ({ actions }) => {
    const context = { project: { repoPath: "/fixture" }, thread: { id: "fixture" }, saveHarnessState: vi.fn() } as unknown as EngineContext;
    const runner = await createNativeCodexRunner(context, { auth: { OPENAI_API_KEY: "fixture" } });
    try {
      const { stream } = await runner.stream({ messages: [{ role: "user", content: "inspect" }], abortSignal: new AbortController().signal });
      const item = { type: "commandExecution", id: "command", command: "opaque-command", cwd: "/fixture", ...(actions != null ? { commandActions: actions } : {}) };
      protocol.notify!({ method: "item/started", params: { threadId: "thread", item } });
      protocol.notify!({ method: "item/completed", params: { threadId: "thread", item: { ...item, aggregatedOutput: "result", exitCode: 0 } } });
      protocol.notify!({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
      const reader = stream.getReader();
      const parts = [];
      for (;;) { const next = await reader.read(); if (next.done) break; parts.push(next.value); }
      const expected = { command: "opaque-command", cwd: "/fixture", ...(actions != null ? { commandActions: actions } : {}) };
      expect(parts.find(part => part.type === "tool-input-delta")).toMatchObject({ delta: JSON.stringify(expected) });
      expect(parts.find(part => part.type === "tool-call")).toMatchObject({ toolName: "Bash", input: expected });
      expect(parts.find(part => part.type === "tool-result")).toMatchObject({ input: expected, output: { output: "result", exitCode: 0 } });
    } finally {
      await runner.finish();
    }
  });
});

it("accepts account-scoped quota notifications without a thread id and makes no quota RPC", async () => {
  const ctx = { project: { repoPath: "/fixture" }, thread: { id: "fixture" }, saveHarnessState: vi.fn() } as unknown as EngineContext;
  const reportUsage = vi.fn(async () => {});
  const runner = await createNativeCodexRunner(ctx, { reportUsage });
  try {
    const { stream } = await runner.stream({ messages: [{ role: "user", content: "hello" }], abortSignal: new AbortController().signal });
    protocol.notify!({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: null } } });
    expect(reportUsage).toHaveBeenCalledWith(expect.objectContaining({ windows: [{ id: "codex-primary_window", label: "5 小时", usedPercent: 25 }] }));
    expect(protocol.request.mock.calls.map(call => call[0])).toEqual(["thread/start", "turn/start"]);
    protocol.notify!({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
    const reader = stream.getReader();
    while (!(await reader.read()).done) { /* drain the ordinary conversation */ }
  } finally { await runner.finish(); }
});
