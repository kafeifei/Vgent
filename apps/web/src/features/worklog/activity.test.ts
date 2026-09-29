import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { processItemsOf, processSectionsOf, splitReply, stepCount, thoughtText } from "./activity";
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
    item.kind === "thought" ? `thought:${item.parts.length}` : "tools" in item ? `${item.kind}:${item.tools.length}` : item.block.kind,
  );

describe("processItemsOf", () => {
  it("hoists the reasoning of one stretch into one row above its calls", () => {
    expect(shape(blocksOf([reasoning("看看"), tool("c1", "Read"), reasoning("再看"), bash("c2", "pnpm test"), reasoning("好了")]))).toEqual([
      "thought:3",
      "tool",
      "tool",
    ]);
  });

  it("groups exploration separately from commands and edits", () => {
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

  it("groups unclassified loops and inline scripts without guessing what they do", () => {
    expect(shape(blocksOf([
      tool("read1", "Read"), tool("read2", "Read"),
      bash("loop", 'F=/app/main.js; for s in setup worktree; do grep "$s" "$F"; done'),
      reasoning("再看一下"),
      bash("node", `node -e 'const s=require("fs").readFileSync("app.js","utf8"); console.log(s.slice(0,50))'`),
      { type: "text", text: "正文保持原位" },
      bash("single", "python3 -c 'print(1)'"),
      tool("edit", "Edit"),
    ]))).toEqual(["thought:1", "explore:2", "commands:2", "text", "tool", "tool"]);
  });

  it.each(["output-error", "output-denied", "approval-requested"])("keeps %s calls between separate command groups", (state) => {
    expect(shape(blocksOf([
      bash("c1", "pnpm test"), bash("c2", "pnpm build"),
      bash("attention", "pnpm check", state),
      bash("c3", "node script.js"), bash("c4", "python3 script.py"),
    ]))).toEqual(["commands:2", "tool", "commands:2"]);
  });

  it("does not fold a nonzero exit code into an exploration group", () => {
    const failed = { ...bash("failed", "rg missing"), output: { exitCode: 1 } } as UIMessage["parts"][number];
    expect(shape(blocksOf([tool("read1", "Read"), failed, tool("read2", "Read")]))).toEqual(["tool", "tool", "tool"]);
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

describe("processSectionsOf", () => {
  it.each([
    { name: "Bash", state: "approval-requested" },
    { name: "askUserQuestions", state: "input-available" },
  ])("keeps pending $name outside completed activity folds", ({ name, state }) => {
    const blocks = blocksOf([bash("before", "pnpm test"), tool("pending", name, {}, state), bash("after", "pnpm build")]);
    const sections = processSectionsOf(blocks);
    expect(sections.map(section => section.kind)).toEqual(["activity", "attention", "activity"]);
    expect(sections[1]).toMatchObject({ block: { part: { toolCallId: "pending" } } });
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
