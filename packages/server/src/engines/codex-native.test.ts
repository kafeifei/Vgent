import { describe, expect, it, vi } from "vitest";
import type { CodexNotification } from "./codex-app-server.js";
import type { EngineContext } from "./registry.js";
import { createNativeCodexRunner } from "./codex-native.js";

const protocol = vi.hoisted(() => ({ notify: undefined as ((event: CodexNotification) => void) | undefined }));

// Exercise the real event adapter without spawning a CLI or touching its home.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), mkdir: vi.fn(async () => undefined) }));
vi.mock("./codex-app-server.js", () => ({
  CodexAppServer: class {
    async initialize() {}
    async request(method: string) {
      return method === "thread/start" ? { thread: { id: "thread" } } : { turn: { id: "turn" } };
    }
    onNotification(callback: (event: CodexNotification) => void) { protocol.notify = callback; return () => { protocol.notify = undefined; }; }
    async close() {}
  },
}));

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
