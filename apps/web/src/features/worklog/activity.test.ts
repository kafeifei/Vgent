import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { processItemsOf, splitReply, stepCount, thoughtText } from "./activity";
import { buildTurns, type Block } from "./turns";

const tool = (id: string, name: string, input: Record<string, unknown> = { file_path: `${id}.ts`, pattern: "x" }, state = "output-available") =>
  ({ type: `tool-${name}`, toolCallId: id, state, input }) as unknown as UIMessage["parts"][number];
const bash = (id: string, command: string, state = "output-available") => tool(id, "Bash", { command }, state);
const reasoning = (text: string, state: "streaming" | "done" = "done") =>
  ({ type: "reasoning", text, state }) as UIMessage["parts"][number];

const blocksOf = (parts: UIMessage["parts"]): Block[] =>
  buildTurns([
    { id: "u", role: "user", parts: [{ type: "text", text: "问" }] },
    { id: "a", role: "assistant", parts },
  ])[0]?.blocks ?? [];

const shape = (blocks: Block[]) =>
  processItemsOf(blocks).map((item) =>
    item.kind === "thought" ? `thought:${item.parts.length}` : item.kind === "explore" ? `explore:${item.tools.length}` : item.block.kind,
  );

describe("processItemsOf", () => {
  it("hoists the reasoning of one stretch into one row above its calls", () => {
    expect(shape(blocksOf([reasoning("看看"), tool("c1", "Read"), reasoning("再看"), bash("c2", "pnpm test"), reasoning("好了")]))).toEqual([
      "thought:3",
      "tool",
      "tool",
    ]);
  });

  it("folds two or more consecutive looks and leaves a lone look and every command alone", () => {
    expect(
      shape(
        blocksOf([
          tool("c1", "Read"),
          bash("c2", "sed -n 1,20p b.ts"),
          tool("c3", "Grep"),
          bash("c4", "pnpm test"),
          bash("c5", "ls src"),
          tool("c6", "Edit"),
          tool("c7", "Read"),
          tool("c8", "Read"),
        ]),
      ),
    ).toEqual(["explore:3", "tool", "tool", "tool", "explore:2"]);
  });

  it("ends a stretch at a reply, an interjection and a card, which stay in place", () => {
    expect(
      shape(
        blocksOf([
          tool("c1", "Read"),
          tool("c2", "Read"),
          { type: "text", text: "先这样" },
          reasoning("想"),
          bash("c3", "pnpm test"),
          { type: "data-steer", data: { text: "顺便" } } as unknown as UIMessage["parts"][number],
          tool("c4", "askUserQuestions"),
          tool("c5", "Read"),
        ]),
      ),
    ).toEqual(["explore:2", "text", "thought:1", "tool", "steer", "tool", "tool"]);
  });
});

describe("splitReply and stepCount", () => {
  it("takes the trailing text as the reply and counts the calls before it", () => {
    const blocks = blocksOf([tool("c1", "Read"), bash("c2", "pnpm test"), { type: "text", text: "改完了" }, { type: "text", text: "再补一句" }]);
    const { process, reply } = splitReply(blocks);
    expect(process.map((block) => block.kind)).toEqual(["tool", "tool"]);
    expect(reply.map((block) => block.kind)).toEqual(["text", "text"]);
    expect(stepCount(process)).toBe(2);
  });

  it("has no reply when the turn stopped on a call", () => {
    const { process, reply } = splitReply(blocksOf([{ type: "text", text: "先看" }, tool("c1", "Read")]));
    expect(process).toHaveLength(2);
    expect(reply).toEqual([]);
  });
});

describe("thoughtText", () => {
  it("joins the parts and skips blank ones", () => {
    const blocks = blocksOf([reasoning("一"), reasoning("  "), reasoning("二")]);
    const item = processItemsOf(blocks)[0];
    if (item?.kind !== "thought") throw new Error("expected a thought");
    expect(thoughtText(item.parts)).toBe("一\n\n二");
  });
});
