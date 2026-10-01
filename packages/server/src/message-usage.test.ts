import { addLanguageModelUsage, asLanguageModelUsage } from "ai/internal";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { addUsageInfo, repairMessageUsage, toUsageInfo } from "./message-usage.js";
import type { EngineId, ThreadMessageMetadata, UsageInfo } from "./types.js";

const answer = (usage: UsageInfo, totalUsage?: UsageInfo): UIMessage => ({
  id: "a", role: "assistant", parts: [], metadata: { usage, ...(totalUsage != null ? { totalUsage } : {}) },
});
const metadata = (message: UIMessage) => message.metadata as ThreadMessageMetadata;
const request = (engine: EngineId): UIMessage => ({
  id: engine, role: "user", parts: [],
  metadata: { run: { id: engine, engine, startedAt: "then", stopReason: "response" } } satisfies ThreadMessageMetadata,
});

describe("legacy OpenCode usage", () => {
  it("normalizes an old live bridge even when its cache is smaller than fresh input", () => {
    const old = asLanguageModelUsage({
      inputTokens: { total: 1_000, noCache: 900, cacheRead: 100, cacheWrite: 50 },
      outputTokens: { total: 200, text: 180, reasoning: 20 },
    });
    expect(toUsageInfo(old, "opencode")).toEqual({
      inputTokensIncludeCache: true, inputTokens: 1_150, outputTokens: 200, totalTokens: 1_350,
      cachedInputTokens: 100, cacheWriteTokens: 50, reasoningTokens: 20,
    });
    for (const engine of ["claude-code", "codex", "vgent"] as const) {
      expect(toUsageInfo(old, engine).inputTokens).toBe(1_000);
    }
  });

  it("repairs step and cumulative counts independently and only once after JSON round trips", () => {
    const corrected = { inputTokens: 1_500, cachedInputTokens: 1_000, inputTokensIncludeCache: true } satisfies UsageInfo;
    const old = { inputTokens: 354, cachedInputTokens: 114_944, outputTokens: 124, totalTokens: 478 };
    const history = [answer(corrected, old), answer(old, corrected)];
    const repaired = repairMessageUsage(history, "opencode");
    expect(metadata(repaired[0]!).usage).toEqual(corrected);
    expect(metadata(repaired[0]!).totalUsage).toMatchObject({ inputTokens: 115_298, totalTokens: 115_422, inputTokensIncludeCache: true });
    expect(metadata(repaired[1]!).usage).toEqual(metadata(repaired[0]!).totalUsage);
    expect(metadata(repaired[1]!).totalUsage).toEqual(corrected);
    expect(repairMessageUsage(JSON.parse(JSON.stringify(repaired)), "opencode")).toEqual(repaired);
    expect(metadata(history[0]!).totalUsage).toEqual(old);
  });

  it("follows the originating run for forked or mixed history, not the current engine", () => {
    const old = { inputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 30 };
    const history = [request("claude-code"), answer(old), request("opencode"), answer(old), request("codex"), answer(old)];
    const repaired = repairMessageUsage(history, "vgent");
    expect(repaired[1]).toBe(history[1]);
    expect(metadata(repaired[3]!).usage).toEqual({ ...old, inputTokens: 60, inputTokensIncludeCache: true });
    expect(repaired[5]).toBe(history[5]);
    for (const engine of ["claude-code", "codex", "vgent"] as const) {
      expect(repairMessageUsage([answer(old)], engine)).toEqual([answer(old)]);
    }
  });

  it("retains unknown fields as unknown and sums normalized steps without losing the marker", () => {
    const none = toUsageInfo(asLanguageModelUsage({ inputTokens: {}, outputTokens: {} }), "opencode");
    expect(none).toEqual({ inputTokensIncludeCache: true });
    const sum = addUsageInfo(none, { inputTokens: 1_100, outputTokens: 100, cachedInputTokens: 1_000, inputTokensIncludeCache: true });
    expect(sum).toEqual({ inputTokens: 1_100, outputTokens: 100, cachedInputTokens: 1_000, inputTokensIncludeCache: true });
    expect(metadata(repairMessageUsage([answer(sum)], "opencode")[0]!).usage).toEqual(sum);
  });

  it("does not re-add cache to a synthetic SDK total at a host-input pause", () => {
    const step = asLanguageModelUsage({
      inputTokens: { total: 1_100, noCache: 100, cacheRead: 1_000, cacheWrite: 0 },
      outputTokens: { total: 50 }, raw: { vgentInputTokensIncludeCache: true },
    });
    const total = addLanguageModelUsage(step, step);
    expect(total.raw).toBeUndefined();
    expect(toUsageInfo(total, "opencode", true)).toMatchObject({ inputTokens: 2_200, cachedInputTokens: 2_000, totalTokens: 2_300 });
  });
});
