import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { forkNote, planFork } from "./fork.js";

const user = (id: string, text: string, metadata?: unknown): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }], ...(metadata != null ? { metadata } : {}) });
const assistant = (id: string, text: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] });

const history = [
  user("u1", "先看一下登录页", { checkpoint: { commit: "aaa" }, checkpointAfter: { commit: "bbb" }, compacted: { before: 3, at: "x" } }),
  assistant("a1", "看完了，有两个问题"),
  user("u2", "修第一个"),
  assistant("a2", "修好了"),
];

describe("planFork", () => {
  it("copies the conversation up to the end of that turn", () => {
    const forked = planFork(history, "u1");
    expect(forked.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(forked.at(-1)?.parts).toEqual(history[1]?.parts);
    // Copies: a fork must not share ids with the task it came from.
    expect(forked.map((message) => message.id)).not.toContain("u1");
  });

  it("takes everything when the turn is the last one", () => {
    expect(planFork(history, "u2")).toHaveLength(4);
  });

  it("drops the source task's checkpoints and keeps the rest of the metadata", () => {
    expect(planFork(history, "u1")[0]?.metadata).toEqual({ compacted: { before: 3, at: "x" } });
  });

  it("refuses a message that is not one of the user's", () => {
    expect(() => planFork(history, "a1")).toThrow();
    expect(() => planFork(history, "nope")).toThrow();
  });
});

describe("forkNote", () => {
  it("is the conversation so far as text, and nothing when there was none", () => {
    const note = forkNote(history.slice(0, 2));
    expect(note).toContain("【用户】\n先看一下登录页");
    expect(note).toContain("【助手】\n看完了，有两个问题");
    expect(forkNote([])).toBeUndefined();
  });

  it("keeps the tail when the conversation is long", () => {
    const long = [user("u", "开头".repeat(40_000)), assistant("a", "结尾在这里")];
    const note = forkNote(long)!;
    expect(note).toContain("更早的部分已省略");
    expect(note).toContain("结尾在这里");
  });
});
