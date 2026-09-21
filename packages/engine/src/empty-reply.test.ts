import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { EMPTY_REPLY_RETRIES } from "./empty-reply.js";
import { createVgentEngine } from "./engine.js";

const NO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, reasoning: undefined },
  totalTokens: undefined,
};

const textStep = (text: string, reason: "stop" | "length" = "stop"): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: reason }, usage: NO_USAGE },
];

const modelOf = (steps: LanguageModelV3StreamPart[][]) =>
  new MockLanguageModelV3({
    doStream: steps.map((chunks) => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: null, initialDelayInMs: null }) })),
  });

async function run(steps: LanguageModelV3StreamPart[][]) {
  const model = modelOf(steps);
  const engine = createVgentEngine({ model, repoPath: await mkdtemp(join(tmpdir(), "vgent-empty-")), permissionMode: "allow-all" });
  const result = await engine.agent.stream({ messages: [{ role: "user", content: "再来一次" }], options: undefined });
  const text = await result.text;
  return { text, calls: model.doStreamCalls.length };
}

describe("a call that comes back with nothing", () => {
  it("is made again, and the blank never reaches the reply", async () => {
    expect(await run([textStep(" "), textStep(" 好的，这就重画。")])).toEqual({ text: " 好的，这就重画。", calls: 2 });
  });

  it("gives up after the retries, leaving the blank as the answer", async () => {
    const blanks = Array.from({ length: EMPTY_REPLY_RETRIES + 1 }, () => textStep(" "));
    expect(await run(blanks)).toEqual({ text: " ", calls: EMPTY_REPLY_RETRIES + 1 });
  });

  it("is left alone when it was cut off rather than empty, and when it said something", async () => {
    expect(await run([textStep("", "length")])).toEqual({ text: "", calls: 1 });
    expect(await run([textStep("行")])).toEqual({ text: "行", calls: 1 });
  });
});
