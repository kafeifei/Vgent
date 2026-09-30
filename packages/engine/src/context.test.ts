import type { ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { estimateTokens, fitContext } from "./context.js";

const screenshot = "iVBORw0KGgo".padEnd(450_000, "A");

describe("estimateTokens", () => {
  it("counts an image as what a model reads, not as its base64", () => {
    const text = estimateTokens([{ role: "user", content: [{ type: "text", text: "看这张图" }] }]);
    for (const part of [
      { type: "image", image: screenshot, mediaType: "image/png" },
      { type: "file", data: { type: "data", data: screenshot }, mediaType: "image/png" },
      { type: "file", mediaType: "image/png", url: `data:image/png;base64,${screenshot}` },
    ]) {
      const withImage = estimateTokens([{ role: "user", content: [{ type: "text", text: "看这张图" }, part] }]);
      expect(withImage - text).toBeGreaterThan(1_000);
      expect(withImage - text).toBeLessThan(3_000);
    }
  });

  it("still counts other files by their size", () => {
    expect(estimateTokens({ type: "file", data: screenshot, mediaType: "application/pdf" })).toBeGreaterThan(100_000);
  });
});

const summarizer = () =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "Read a.ts to d.ts; next: edit e.ts." }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  });

/** One agentic turn: a request, then `steps` reads of `size` characters each. */
const longTurn = (request: string, steps: number, size: number): ModelMessage[] => [
  { role: "user", content: request },
  ...Array.from({ length: steps }, (_, i): ModelMessage[] => [
    { role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool-call", toolCallId: `c${i}`, toolName: "read", input: { path: `f${i}.ts` } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read", output: { type: "text", value: `${i}`.repeat(size) } }] },
  ]).flat(),
];

const paired = (messages: ModelMessage[]) => {
  const calls = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result" && !calls.has(part.toolCallId)) return false;
    }
  }
  return true;
};

describe("fitContext", () => {
  it("summarizes the earlier steps of a single long turn, keeping its request word for word", async () => {
    const model = summarizer();
    const messages = longTurn("改 Provider 的全选开关，别动我的改动。", 8, 16_000);
    const result = await fitContext({ model, messages, budget: 10_000 });

    expect(result.compacted).toBe(true);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toMatchObject({ role: "user", content: expect.stringContaining("Read a.ts to d.ts") });
    expect(result.messages[2]?.role).toBe("assistant");
    expect(JSON.stringify(result.messages)).toContain("7".repeat(16_000));
    expect(paired(result.messages)).toBe(true);
    expect(estimateTokens(result.messages)).toBeLessThanOrEqual(10_000);
    // The request is not summarized: it is kept above.
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).not.toContain("改 Provider 的全选开关");
  });

  it("cuts inside the latest turn when that turn alone does not fit after the last user message", async () => {
    const model = summarizer();
    const earlier: ModelMessage[] = [
      { role: "user", content: "先看看项目" },
      { role: "assistant", content: "看完了" },
    ];
    const messages = [...earlier, ...longTurn("继续", 8, 16_000)];
    const result = await fitContext({ model, messages, budget: 10_000 });

    expect(result.messages[0]).toEqual({ role: "user", content: "继续" });
    expect(result.messages[2]?.role).toBe("assistant");
    expect(paired(result.messages)).toBe(true);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("先看看项目");
  });

  it("still refuses when the latest step alone is bigger than the budget", async () => {
    const model = summarizer();
    await expect(fitContext({ model, messages: longTurn("读大文件", 2, 60_000), budget: 10_000 })).rejects.toThrow(/容量/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
