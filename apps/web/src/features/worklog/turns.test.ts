import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildTurns } from "./turns";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const assistant = (id: string, parts: UIMessage["parts"]): UIMessage => ({ id, role: "assistant", parts });

const toolPart = (toolCallId: string, state: string, name = "bash") =>
  ({ type: `tool-${name}`, toolCallId, state, input: { command: "ls", file_path: "a.ts", pattern: "x" }, ...(state === "approval-requested" ? { approval: { id: `ap-${toolCallId}` } } : {}) }) as unknown as UIMessage["parts"][number];

const stepStart = { type: "step-start" } as UIMessage["parts"][number];

describe("buildTurns", () => {
  it("opens a turn per user message and folds the assistant messages into it", () => {
    const turns = buildTurns([
      user("u1", "第一问"),
      assistant("a1", [{ type: "text", text: "答一" }]),
      user("u2", "第二问"),
      assistant("a2", [{ type: "reasoning", text: "想", state: "done" } as UIMessage["parts"][number]]),
      assistant("a3", [{ type: "text", text: "答二" }]),
    ]);
    expect(turns.map((turn) => turn.user?.id)).toEqual(["u1", "u2"]);
    expect(turns[1]?.blocks.map((block) => block.kind)).toEqual(["reasoning", "text"]);
  });

  /** An engine that reasons without summarizing sends an empty part every turn. */
  it("drops a reasoning part that has no text", () => {
    const turns = buildTurns([
      user("u1", "问"),
      assistant("a1", [
        { type: "reasoning", text: "", state: "done" } as UIMessage["parts"][number],
        { type: "text", text: "答" },
      ]),
    ]);
    expect(turns[0]?.blocks.map((block) => block.kind)).toEqual(["text"]);
  });

  it("gives a history that starts with an assistant message a user-less turn", () => {
    const turns = buildTurns([assistant("a1", [{ type: "text", text: "续流" }])]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBeUndefined();
  });

  /**
   * A call the engine only half-announced before pausing for an approval comes
   * back as a second part with the same id in the next step; the stale one never
   * leaves `input-streaming` and would render as a row that runs forever.
   */
  it("keeps only the last part of a re-issued tool call", () => {
    const turns = buildTurns([
      user("u1", "改文件"),
      assistant("a1", [
        stepStart,
        toolPart("c1", "output-available"),
        toolPart("c2", "input-streaming"),
        stepStart,
        toolPart("c2", "output-available"),
      ]),
    ]);
    const blocks = turns[0]?.blocks ?? [];
    expect(blocks.map((block) => (block.kind === "tool" ? block.part.toolCallId : block.kind))).toEqual(["c1", "c2"]);
    expect(blocks[1]?.kind === "tool" && blocks[1].part.state).toBe("output-available");
  });
});

describe("a reply with nothing in it", () => {
  it("drops blank text, and tells a turn that was answered with nothing from one still waiting", () => {
    const turns = buildTurns([
      user("u1", "再来一次"),
      assistant("a1", [stepStart, { type: "text", text: " " }]),
      user("u2", "挂了？"),
    ]);
    expect(turns.map((turn) => [turn.blocks.length, turn.answered])).toEqual([
      [0, true],
      [0, false],
    ]);
  });
});

describe("插话", () => {
  const steer = (text: string) => ({ type: "data-steer", id: text, data: { text } }) as unknown as UIMessage["parts"][number];

  it("stays inside the turn it went into, where it went in, and is never folded", () => {
    const turns = buildTurns([
      user("u1", "重构 a.ts"),
      assistant("a1", [
        stepStart,
        toolPart("c1", "output-available", "read"),
        toolPart("c2", "output-available", "read"),
        steer("顺便改 b.ts"),
        stepStart,
        toolPart("c3", "output-available", "bash"),
        toolPart("c4", "output-available", "bash"),
        { type: "text", text: "都改好了" },
      ]),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.blocks.map((block) => (block.kind === "steer" ? `steer:${block.text}` : block.kind))).toEqual([
      "tool",
      "tool",
      "steer:顺便改 b.ts",
      "tool",
      "tool",
      "text",
    ]);
  });

  it("ignores a data part that is not one", () => {
    const turns = buildTurns([user("u1", "问"), assistant("a1", [{ type: "data-other", data: {} } as unknown as UIMessage["parts"][number], { type: "text", text: "答" }])]);
    expect(turns[0]?.blocks.map((block) => block.kind)).toEqual(["text"]);
  });
});

describe("pending steer reconciliation", () => {
  const pending = { id: "s1", text: "调整方向", mode: "steer" as const, accepted: true, createdAt: "2026-09-26" };
  const receipt = { type: "data-steer", id: "s1", data: { text: "调整方向", messageId: "s1", receipt: true } } as unknown as UIMessage["parts"][number];
  it("shows a submitted steer before its stream receipt, keeping next-turn messages outside the log", () => {
    const turns = buildTurns([user("u1", "工作")], [pending, { ...pending, id: "q1", mode: "queue" }], true);
    expect(turns[0]?.blocks).toMatchObject([{ kind: "steer", messageId: "s1", pending: true, interrupt: true }]);
  });
  it("updates the same bubble on receipt and keeps its action until applied", () => {
    const messages = [user("u1", "工作"), assistant("a1", [receipt])];
    expect(buildTurns(messages, [pending], true)[0]?.blocks).toMatchObject([{ messageId: "s1", pending: true }]);
    expect(buildTurns(messages, [{ ...pending, applied: true }], true)[0]?.blocks).toMatchObject([{ messageId: "s1", pending: false }]);
    expect(buildTurns(messages, [pending], false)[0]?.blocks).toMatchObject([{ messageId: "s1", interrupt: false }]);
  });
  it("reconciles an older random receipt id once, and drops the embedded copy when promoted", () => {
    const legacy = { type: "data-steer", id: "old-random-id", data: { text: pending.text } } as unknown as UIMessage["parts"][number];
    expect(buildTurns([user("u1", "工作"), assistant("a1", [legacy])], [pending], true)[0]?.blocks).toMatchObject([{ messageId: "s1", pending: true }]);
    expect(buildTurns([user("u1", "工作"), assistant("a1", [receipt]), user("s1", pending.text)], [], true).flatMap(turn => turn.blocks)).toEqual([]);
  });
});

it("does not attach a new identical steer to an earlier stable receipt", () => {
  const old = { type: "data-steer", id: "old", data: { text: "again", messageId: "old" } } as UIMessage["parts"][number];
  const queue = [{ id: "new", text: "again", mode: "steer" as const, createdAt: "2026-09-26" }];
  const blocks = buildTurns([user("u1", "work"), assistant("a1", [old])], queue, true)[0]!.blocks;
  expect(blocks).toHaveLength(2);
  expect(blocks[0]).not.toHaveProperty("pending");
  expect(blocks[1]).toMatchObject({ messageId: "new", pending: true });
});
