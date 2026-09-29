import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { createChunkHub } from "./chunk-hub.js";

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) chunks.push(chunk);
  return chunks;
}

describe("createChunkHub", () => {
  it("replays the whole buffer to a late subscriber", async () => {
    const hub = createChunkHub();
    hub.publish({ type: "start", messageId: "m1" });
    hub.publish({ type: "text-start", id: "t1" });
    hub.publish({ type: "text-delta", id: "t1", delta: "你好" });

    const late = hub.subscribe();
    hub.publish({ type: "text-end", id: "t1" });
    hub.close();

    expect(await drain(late)).toEqual(hub.chunks);
  });

  it("gives two subscribers the identical sequence", async () => {
    const hub = createChunkHub();
    const early = hub.subscribe();
    hub.publish({ type: "start", messageId: "m1" });
    hub.publish({ type: "text-start", id: "t1" });
    const late = hub.subscribe();
    hub.publish({ type: "text-delta", id: "t1", delta: "hi" });
    hub.publish({ type: "text-end", id: "t1" });
    hub.close();

    const [a, b] = await Promise.all([drain(early), drain(late)]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
  });

  it("closing ends every open stream", async () => {
    const hub = createChunkHub();
    const streams = [hub.subscribe(), hub.subscribe()];
    hub.publish({ type: "start" });
    hub.close();
    // Publishing after close is a no-op, so the drained streams stay at one chunk.
    hub.publish({ type: "text-start", id: "ignored" });
    for (const stream of streams) expect(await drain(stream)).toHaveLength(1);
  });

  it("aborting a subscriber removes it without affecting the others", async () => {
    const hub = createChunkHub();
    const controller = new AbortController();
    const aborted = hub.subscribe(controller.signal);
    const survivor = hub.subscribe();

    hub.publish({ type: "start" });
    controller.abort();
    hub.publish({ type: "text-start", id: "t1" });
    hub.close();

    expect(await drain(aborted)).toHaveLength(1);
    expect(await drain(survivor)).toHaveLength(2);
  });

  it("keeps only a call's latest preliminary output, and replays the same message", async () => {
    const hub = createChunkHub();
    hub.publish({ type: "start", messageId: "m1" });
    hub.publish({ type: "tool-input-available", toolCallId: "c1", toolName: "explore", input: { prompt: "look" } });
    for (let step = 1; step <= 50; step++) {
      hub.publish({ type: "tool-output-available", toolCallId: "c1", output: { step }, preliminary: true });
    }
    hub.publish({ type: "text-start", id: "t1" });
    hub.publish({ type: "text-delta", id: "t1", delta: "done" });
    hub.publish({ type: "text-end", id: "t1" });
    hub.publish({ type: "tool-output-available", toolCallId: "c1", output: { step: "final" } });
    hub.close();

    const outputs = hub.chunks.filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs).toEqual([{ type: "tool-output-available", toolCallId: "c1", output: { step: "final" } }]);

    let replayed: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream: hub.subscribe() })) replayed = message;
    expect(replayed?.parts).toEqual([
      expect.objectContaining({ type: "tool-explore", state: "output-available", output: { step: "final" } }),
      expect.objectContaining({ type: "text", text: "done" }),
    ]);
  });

  it("lets a subscriber that has not read yet skip outputs superseded meanwhile", async () => {
    const hub = createChunkHub();
    const slow = hub.subscribe();
    hub.publish({ type: "tool-input-available", toolCallId: "c1", toolName: "explore", input: {} });
    for (let step = 1; step <= 50; step++) {
      hub.publish({ type: "tool-output-available", toolCallId: "c1", output: { step }, preliminary: true });
    }
    hub.close();

    const outputs = (await drain(slow)).filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs.length).toBeLessThanOrEqual(2);
    expect(outputs.at(-1)).toMatchObject({ output: { step: 50 }, preliminary: true });
  });

  it("interrupt closes open text, reasoning and non-terminal tool calls", async () => {
    const hub = createChunkHub();
    hub.publish({ type: "text-start", id: "t1" });
    hub.publish({ type: "reasoning-start", id: "r1" });
    hub.publish({ type: "tool-input-available", toolCallId: "c1", toolName: "bash", input: {} });
    hub.publish({ type: "tool-input-available", toolCallId: "c2", toolName: "read", input: {} });
    hub.publish({ type: "tool-output-available", toolCallId: "c2", output: "done" });

    hub.interrupt("已停止");
    hub.close();

    const tail = hub.chunks.slice(5);
    expect(tail).toEqual([
      { type: "tool-output-error", toolCallId: "c1", errorText: "已停止" },
      { type: "text-end", id: "t1" },
      { type: "reasoning-end", id: "r1" },
    ]);
  });
});
