import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildTurns, runsOf } from "./turns";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const assistant = (id: string, parts: UIMessage["parts"]): UIMessage => ({ id, role: "assistant", parts });

const toolPart = (toolCallId: string, state: string) =>
  ({ type: "tool-bash", toolCallId, state, input: { command: "ls" }, ...(state === "approval-requested" ? { approval: { id: `ap-${toolCallId}` } } : {}) }) as unknown as UIMessage["parts"][number];

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

  it("gives a history that starts with an assistant message a user-less turn", () => {
    const turns = buildTurns([assistant("a1", [{ type: "text", text: "续流" }])]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBeUndefined();
  });
});

describe("runsOf", () => {
  it("keeps order: text splits the foldable runs around it", () => {
    const turns = buildTurns([
      user("u1", "做点事"),
      assistant("a1", [
        toolPart("c1", "output-available"),
        { type: "text", text: "中间说明" },
        toolPart("c2", "output-available"),
      ]),
    ]);
    const runs = runsOf(turns[0]?.blocks ?? []);
    expect(runs.map((run) => run.kind)).toEqual(["foldable", "open", "foldable"]);
  });

  it("never folds a call that is waiting on the human", () => {
    const turns = buildTurns([
      user("u1", "跑个命令"),
      assistant("a1", [toolPart("c1", "output-available"), toolPart("c2", "approval-requested")]),
    ]);
    const runs = runsOf(turns[0]?.blocks ?? []);
    expect(runs.map((run) => run.kind)).toEqual(["foldable", "open"]);
  });
});
