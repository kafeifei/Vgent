import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ChangedFile, ThreadMessageMetadata } from "@/lib/types";
import { contextUsage, formatTokens, sumChanges } from "./contextUsage";

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
});

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates the rest", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(272_000)).toBe("272k");
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
