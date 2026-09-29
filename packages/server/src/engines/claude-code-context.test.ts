import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "./registry.js";
import { createClaudeCodeEngineFactory } from "./claude-code.js";

const engine = vi.hoisted(() => ({ create: vi.fn() }));

// What the factory hands the harness, without starting a bridge.
vi.mock("@vgent/engines", async (original) => ({
  ...(await original<typeof import("@vgent/engines")>()),
  createClaudeCodeEngine: async (options: unknown) => {
    engine.create(options);
    return { session: {}, harnessAgent: {}, dispose: async () => {} };
  },
}));

describe("Claude Code 上下文", () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), "vgent-cc-context-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const start = async (thread: { model?: string; contextWindow?: number }) => {
    const ctx = { thread: { id: "fixture", ...thread }, project: { repoPath: dir }, dataDir: dir, planMode: false, permissionMode: "default", log: console } as unknown as EngineContext;
    await createClaudeCodeEngineFactory().create(ctx);
    return engine.create.mock.calls.at(-1)?.[0] as { model?: string; env?: Record<string, string> };
  };

  it("compacts at the standard 200K when the task chose no window", async () => {
    const options = await start({ model: "claude-opus-5-5" });
    expect(options.model).toBe("claude-opus-5-5");
    expect(options.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  });

  it("asks for the long window on the model name and compacts there", async () => {
    const options = await start({ model: "claude-opus-5-5", contextWindow: 1_000_000 });
    expect(options.model).toBe("claude-opus-5-5[1m]");
    expect(options.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" });
  });

  it("holds a task with no model to the standard window too", async () => {
    const options = await start({});
    expect(options).not.toHaveProperty("model");
    expect(options.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" });
  });
});
