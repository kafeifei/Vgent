import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ChangedFile, ThreadMessageMetadata } from "@/lib/types";
import { contextUsage, formatTokens, sumChanges, taskUsage, usageCost } from "./contextUsage";
import { repairMessageUsage } from "../../../../../packages/server/src/message-usage";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const assistant = (id: string, text: string, metadata?: ThreadMessageMetadata): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
  ...(metadata != null ? { metadata } : {}),
});

const file = (path: string, additions: number, deletions: number): ChangedFile => ({
  path,
  status: "modified",
  additions,
  deletions,
  binary: false,
});

describe("contextUsage", () => {
  it("reports the last assistant message that carries usage", () => {
    const messages = [
      user("u1", "一"),
      assistant("a1", "好", { usage: { inputTokens: 100 } }),
      user("u2", "二"),
      assistant("a2", "好", { usage: { inputTokens: 4200, outputTokens: 30 } }),
    ];

    expect(contextUsage(messages)).toEqual({ tokens: 4200, source: "usage" });
  });

  it("skips assistant messages without usage and keeps looking backwards", () => {
    const messages = [assistant("a1", "好", { usage: { inputTokens: 100 } }), user("u2", "二"), assistant("a2", "好")];

    expect(contextUsage(messages)).toEqual({ tokens: 100, source: "usage" });
  });

  it("skips assistant messages with zero inputTokens (Codex bridge's unreported usage)", () => {
    const messages = [assistant("a1", "好", { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0 } })];

    expect(contextUsage(messages)).toEqual({ tokens: 0, source: "estimate" });
  });

  it("estimates from characters when no engine reported anything", () => {
    // 40 characters of text + 20 of tool JSON ⇒ 60 / 4 = 15.
    const messages: UIMessage[] = [
      user("u1", "a".repeat(40)),
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-read", toolCallId: "c1", state: "input-available", input: { p: "b".repeat(11) } }],
      } as UIMessage,
    ];

    expect(contextUsage(messages)).toEqual({ tokens: 15, source: "estimate" });
  });

  it("counts reasoning text and tool output into the estimate", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "x".repeat(8) },
          { type: "tool-read", toolCallId: "c1", state: "output-available", input: 1, output: 2 },
        ],
      } as UIMessage,
    ];

    // 8 reasoning chars + "1" + "2" = 10 ⇒ 2.5, rounded to 3.
    expect(contextUsage(messages)).toEqual({ tokens: 3, source: "estimate" });
  });

  it("is an empty estimate for an empty thread", () => {
    expect(contextUsage([])).toEqual({ tokens: 0, source: "estimate" });
  });

  it("invalidates pre-compact usage until the next model call reports fresh usage", () => {
    const compact: UIMessage = {
      ...user("compact", "/compact"),
      metadata: {
        compactRequested: { at: "now" },
        run: { id: "r", engine: "claude-code", startedAt: "then", endedAt: "now", stopReason: "response", finishReason: "stop" },
      } satisfies ThreadMessageMetadata,
    };
    const history = [assistant("before", "旧上下文", { usage: { inputTokens: 504206 } }), compact,
      assistant("empty", "", { totalUsage: { inputTokens: 0, outputTokens: 0 } })];
    expect(contextUsage(history)).toEqual({ tokens: undefined, source: "unknown" });
    expect(contextUsage([...history, user("next", "继续"), assistant("fresh", "好了", { usage: { inputTokens: 7730 } })]))
      .toEqual({ tokens: 7730, source: "usage" });
    // Older requests used `compacted`; ordinary summaries must not invalidate
    // the character estimate of their actual replacement history.
    compact.metadata = { ...(compact.metadata as ThreadMessageMetadata), compactRequested: undefined, compacted: { before: 14, at: "now" } };
    expect(contextUsage(history)).toEqual({ tokens: undefined, source: "unknown" });
    expect(contextUsage([{ ...user("summary", "abcd"), metadata: { compacted: { before: 14, at: "now" } } }]))
      .toEqual({ tokens: 1, source: "estimate" });
  });

  it.each(["running", "error", "cancelled"])("keeps the previous usage for an uncompleted %s request", (stopReason) => {
    expect(contextUsage([
      assistant("before", "好", { usage: { inputTokens: 504206 } }),
      { ...user("compact", "/compact"), metadata: {
        compactRequested: { at: "now" }, run: { id: "r", engine: "claude-code", startedAt: "then", stopReason },
      } satisfies ThreadMessageMetadata },
    ])).toEqual({ tokens: 504206, source: "usage" });
  });
});

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates the rest", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(272_000)).toBe("272k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(3_240_000)).toBe("3.2M");
  });
});

describe("taskUsage", () => {
  it("adds up every turn's totalUsage, not the last step's usage", () => {
    const messages = [
      user("u1", "一"),
      assistant("a1", "好", {
        usage: { inputTokens: 900 },
        totalUsage: { inputTokens: 1000, cachedInputTokens: 600, cacheWriteTokens: 100, outputTokens: 50, reasoningTokens: 20 },
      }),
      user("u2", "二"),
      assistant("a2", "好", { usage: { inputTokens: 2000 }, totalUsage: { inputTokens: 3000, cachedInputTokens: 2400, outputTokens: 70 } }),
    ];

    expect(taskUsage(messages)).toEqual({
      inputTokens: 4000,
      inputTokenDetails: { noCacheTokens: 900, cacheReadTokens: 3000, cacheWriteTokens: 100 },
      outputTokens: 120,
      outputTokenDetails: { textTokens: 100, reasoningTokens: 20 },
      totalTokens: 4120,
    });
  });

  it("is undefined until some turn reported real numbers", () => {
    expect(taskUsage([user("u1", "一"), assistant("a1", "好")])).toBeUndefined();
    expect(taskUsage([assistant("a1", "好", { totalUsage: { inputTokens: 0, outputTokens: 0 } })])).toBeUndefined();
  });
});

describe("usageCost", () => {
  const usage = taskUsage([
    assistant("a1", "好", { totalUsage: { inputTokens: 1_000_000, cachedInputTokens: 600_000, cacheWriteTokens: 100_000, outputTokens: 100_000 } }),
  ])!;

  it("prices fresh input, cache reads and cache writes apart", () => {
    const cost = usageCost(usage, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
    // 300k fresh × $4 + 600k read × $0.2 + 100k written × $5, per million.
    expect(cost.input).toBeCloseTo(1.2 + 0.12 + 0.5);
    expect(cost.output).toBeCloseTo(2);
    expect(cost.total).toBeCloseTo(3.82);
  });

  it("charges cache traffic as fresh input when the vendor gives it no price", () => {
    expect(usageCost(usage, { input: 4, output: 20 }).input).toBeCloseTo(4);
  });

  it("shows the observed OpenCode task as 42%, with its full cumulative input and fresh-input price", () => {
    const messages = repairMessageUsage([assistant("a", "done", {
      usage: { inputTokens: 354, cachedInputTokens: 114_944, outputTokens: 124, totalTokens: 478 },
      totalUsage: { inputTokens: 120_406, cachedInputTokens: 2_422_144, cacheWriteTokens: 0, outputTokens: 14_156, reasoningTokens: 1_946, totalTokens: 134_562 },
    })], "opencode");
    const context = contextUsage(messages);
    expect(context).toEqual({ tokens: 115_298, source: "usage" });
    expect(Math.round(context.tokens! / 272_000 * 100)).toBe(42);
    const total = taskUsage(messages)!;
    expect(total.inputTokens).toBe(2_542_550);
    expect(total.inputTokenDetails.noCacheTokens).toBe(120_406);
    expect(Math.round(total.inputTokenDetails.cacheReadTokens! / total.inputTokens! * 100)).toBe(95);
    const cost = usageCost(total, { input: 4, output: 20, cacheRead: 0.2 });
    expect(cost.input).toBeCloseTo((120_406 * 4 + 2_422_144 * 0.2) / 1e6);
    expect(cost.output).toBeCloseTo(14_156 * 20 / 1e6);
    expect(cost.total).toBeCloseTo(1.2491728);
  });
});

describe("sumChanges", () => {
  it("sums additions and deletions over the files", () => {
    expect(sumChanges([file("a.ts", 10, 2), file("b.ts", 1, 0), file("c.ts", 0, 7)])).toEqual({
      files: 3,
      additions: 11,
      deletions: 9,
    });
  });

  it("is all zeroes for no files", () => {
    expect(sumChanges([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});
