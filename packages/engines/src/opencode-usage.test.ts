import { runInNewContext } from "node:vm";
import { asLanguageModelUsage } from "ai/internal";
import { beforeAll, describe, expect, it } from "vitest";
import { toUsageInfo } from "../../server/src/message-usage.js";
import { harnessBootstrapRecipe } from "./bootstrap.js";

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
type Usage = Parameters<typeof asLanguageModelUsage>[0];
let bridge: {
  mapUsage(tokens: unknown): Usage;
  addUsage(input: { left: Usage | undefined; right: Usage }): Usage;
  subtractSessionTokens(input: { before: Tokens; after: Tokens }): Tokens;
};

beforeAll(async () => {
  const recipe = await harnessBootstrapRecipe("opencode");
  const source = recipe!.files.find((file) => file.path.endsWith("/bridge.mjs"))!.content;
  // Execute the actual bundled modules that the desktop bootstrap ships, with
  // no CLI, login or server startup. Assertions exercise behavior, not source text.
  const module = (name: string) => {
    const start = source.indexOf(`// src/bridge/${name}.ts\n`);
    if (start < 0) throw new Error(`Bridge module missing: ${name}`);
    return source.slice(start, source.indexOf("\n// src/bridge/", start + 1));
  };
  bridge = runInNewContext(`${module("opencode-types")}\n${module("opencode-usage")}\n({ mapUsage, addUsage, subtractSessionTokens })`);
});

describe("OpenCode bootstrap usage → SDK → persisted message", () => {
  it.each([
    { name: "observed high cache hit", fresh: 354, read: 114_944, write: 0, expected: 115_298 },
    { name: "low cache hit", fresh: 1_000, read: 100, write: 50, expected: 1_150 },
    { name: "entirely cached prompt", fresh: 0, read: 2_048, write: 0, expected: 2_048 },
    { name: "cache write only", fresh: 0, read: 0, write: 2_048, expected: 2_048 },
    { name: "no cache", fresh: 1_000, read: 0, write: 0, expected: 1_000 },
  ])("includes all input exactly once: $name", ({ fresh, read, write, expected }) => {
    const usage = asLanguageModelUsage(bridge.mapUsage({ input: fresh, output: 124, reasoning: 50, cache: { read, write } }));
    expect(usage.inputTokens).toBe(expected);
    expect(usage.inputTokenDetails).toEqual({ noCacheTokens: fresh, cacheReadTokens: read, cacheWriteTokens: write });
    expect(toUsageInfo(usage, "opencode")).toEqual({
      inputTokensIncludeCache: true, inputTokens: expected, cachedInputTokens: read, cacheWriteTokens: write,
      outputTokens: 174, reasoningTokens: 50, totalTokens: expected + 174,
    });
  });

  it("preserves normalized totals across multiple steps and the session-difference fallback", () => {
    const first = { input: 1_000, output: 80, reasoning: 20, cache: { read: 0, write: 100 } };
    const second = { input: 100, output: 90, reasoning: 30, cache: { read: 1_100, write: 0 } };
    const summed = bridge.addUsage({ left: bridge.mapUsage(first), right: bridge.mapUsage(second) });
    const after = { input: 1_100, output: 170, reasoning: 50, cache: { read: 1_100, write: 100 } };
    const fallback = bridge.mapUsage(bridge.subtractSessionTokens({ before: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, after }));
    expect(summed).toEqual(fallback);
    expect(toUsageInfo(asLanguageModelUsage(summed), "opencode")).toMatchObject({
      inputTokensIncludeCache: true, inputTokens: 2_300, outputTokens: 220, totalTokens: 2_520,
      cachedInputTokens: 1_100, cacheWriteTokens: 100, reasoningTokens: 50,
    });
    expect(bridge.addUsage({ left: undefined, right: summed })).toEqual(summed);
  });
});
