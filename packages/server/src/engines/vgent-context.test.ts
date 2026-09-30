import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "./registry.js";
import { createVgentEngineFactory } from "./vgent.js";

const engine = vi.hoisted(() => ({ create: vi.fn() }));

// What the factory hands the engine, without running a turn.
vi.mock("@vgent/engine", async (original) => ({
  ...(await original<typeof import("@vgent/engine")>()),
  createVgentEngine: (options: unknown) => {
    engine.create(options);
    return { agent: {}, tools: {}, outcome: () => ({}), dispose: async () => {} };
  },
}));

describe("Vgent 上下文", () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), "vgent-context-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const start = async (thread: { model?: string; contextWindow?: number }, windowOf?: (model: string) => Promise<number | undefined>) => {
    const factory = createVgentEngineFactory({ model: new MockLanguageModelV3(), ...(windowOf != null ? { windowOf } : {}) });
    const ctx = {
      thread: { id: "fixture", projectId: "p", messages: [], ...thread },
      project: { id: "project-fixture", name: "fixture", repoPath: dir },
      projectPath: dir,
      dataDir: dir,
      planMode: false,
      permissionMode: "allow-edits",
      alwaysAllow: [],
      takeSteers: () => [],
      log: console,
    } as unknown as EngineContext;
    await factory.create(ctx);
    return engine.create.mock.calls.at(-1)?.[0] as { contextTokenBudget?: number };
  };

  it("prunes at the model's own window, the one its ring shows, when the task chose none", async () => {
    const windowOf = vi.fn(async (model: string) => (model === "codex-subscription:gpt-6-astra" ? 272_000 : undefined));
    const options = await start({ model: "codex-subscription:gpt-6-astra" }, windowOf);
    expect(options.contextTokenBudget).toBe(217_600);
  });

  it("prunes at the chosen window without asking the list", async () => {
    const windowOf = vi.fn(async () => 272_000);
    const options = await start({ model: "codex-subscription:gpt-6-astra", contextWindow: 1_050_000 }, windowOf);
    expect(options.contextTokenBudget).toBe(840_000);
    expect(windowOf).not.toHaveBeenCalled();
  });

  it("leaves the engine's default when nobody knows the window", async () => {
    expect(await start({ model: "somewhere/unknown" }, async () => undefined)).not.toHaveProperty("contextTokenBudget");
    expect(await start({ model: "somewhere/unknown" }, async () => Promise.reject(new Error("catalog down")))).not.toHaveProperty("contextTokenBudget");
  });
});
