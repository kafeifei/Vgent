import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { expandSteers, steerChunk, steerTextOf } from "./steer.js";

const steer = (text: string) => ({ type: "data-steer", id: "s", data: { text } }) as UIMessage["parts"][number];
const text = (value: string) => ({ type: "text", text: value }) as UIMessage["parts"][number];
const step = { type: "step-start" } as UIMessage["parts"][number];

describe("steer", () => {
  it("is a data chunk the UI message stream carries as it is", () => {
    const chunk = steerChunk("先别动数据库") as { type: string; id: string; data: { text: string } };
    expect(chunk.type).toBe("data-steer");
    expect(chunk.data).toEqual({ text: "先别动数据库" });
    expect(steerTextOf(steer("x"))).toBe("x");
    expect(steerTextOf(text("x"))).toBeUndefined();
  });

  it("cuts an assistant message into the conversation it was", () => {
    const user: UIMessage = { id: "u1", role: "user", parts: [text("重构 a.ts")] };
    const assistant: UIMessage = {
      id: "a1",
      role: "assistant",
      metadata: { usage: 1 },
      parts: [step, text("先看文件"), step, steer("顺便改 b.ts"), step, text("好，两个都改"), steer("算了 b 不改"), step],
    };
    const expanded = expandSteers([user, assistant]);
    expect(expanded.map((message) => [message.role, message.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text)])).toEqual([
      ["user", ["重构 a.ts"]],
      ["assistant", ["先看文件"]],
      ["user", ["顺便改 b.ts"]],
      ["assistant", ["好，两个都改"]],
      ["user", ["算了 b 不改"]],
    ]);
    expect(new Set(expanded.map((message) => message.id)).size).toBe(expanded.length);
    expect(expanded.some((message) => message.parts.some((part) => part.type === "data-steer"))).toBe(false);
  });

  it("returns untouched messages by identity", () => {
    const plain: UIMessage = { id: "a1", role: "assistant", parts: [text("好")] };
    expect(expandSteers([plain])[0]).toBe(plain);
  });
});
