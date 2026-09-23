import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { activityMode, segmentsOf, summaryLabel, thinkingLabel, type ActivityRun } from "./activity";
import { buildTurns, type Block } from "./turns";

const tool = (id: string, name: string, state = "output-available") =>
  ({
    type: `tool-${name}`,
    toolCallId: id,
    state,
    input: { file_path: `${id}.ts`, command: "pnpm test", pattern: "x" },
  }) as unknown as UIMessage["parts"][number];

const reasoning = (text: string, state: "streaming" | "done" = "done") =>
  ({ type: "reasoning", text, state }) as UIMessage["parts"][number];

const blocksOf = (parts: UIMessage["parts"]): Block[] =>
  buildTurns([
    { id: "u", role: "user", parts: [{ type: "text", text: "问" }] },
    { id: "a", role: "assistant", parts },
  ])[0]?.blocks ?? [];

const run = (blocks: Block[]): ActivityRun => {
  const segment = segmentsOf(blocks)[0];
  if (segment?.kind !== "activity") throw new Error("expected an activity run");
  return segment;
};

describe("segmentsOf", () => {
  it("keeps a thought on the title only until a tool follows it", () => {
    const before = run(blocksOf([reasoning("想一下"), tool("c1", "read")]));
    expect(before.tools).toHaveLength(1);
    expect(before.thought).toEqual([]);

    const after = run(blocksOf([tool("c1", "read"), reasoning("再看一眼")]));
    expect(after.tools).toHaveLength(1);
    expect(after.thought.map((block) => block.part.text)).toEqual(["再看一眼"]);
  });

  it("ends the run at a reply, an interjection, a plan, and a question", () => {
    const segments = segmentsOf(
      blocksOf([
        tool("c1", "read"),
        tool("c2", "read"),
        { type: "text", text: "先这样" },
        tool("c3", "bash"),
        { type: "data-steer", data: { text: "顺便" } } as unknown as UIMessage["parts"][number],
        tool("c4", "updatePlan", "output-available"),
        tool("c5", "askUserQuestions", "output-available"),
      ]),
    );
    expect(segments.map((segment) => (segment.kind === "activity" ? `run:${segment.tools.length}` : segment.block.kind))).toEqual([
      "run:2",
      "text",
      "run:1",
      "steer",
      "tool",
      "tool",
    ]);
  });
});

describe("activityMode", () => {
  it("stays open on the live edge and collapses a finished run of two or more tools", () => {
    expect(activityMode(3, true)).toBe("live");
    expect(activityMode(3, false)).toBe("summary");
    expect(activityMode(1, false)).toBe("plain");
    expect(activityMode(0, true)).toBe("live");
    expect(activityMode(0, false)).toBe("omit");
  });
});

describe("thinkingLabel", () => {
  const thought = (text: string, state: "streaming" | "done" = "done"): Extract<Block, { kind: "reasoning" }> => ({
    kind: "reasoning",
    key: "r",
    part: { type: "reasoning", text, state } as Extract<Block, { kind: "reasoning" }>["part"],
  });

  it("uses a heading the thought already has, and otherwise a generic label", () => {
    expect(thinkingLabel([])).toEqual({ label: "正在思考", streaming: true });
    expect(thinkingLabel([thought("想一下")])).toEqual({ label: "想一下", streaming: false });
    expect(thinkingLabel([thought("**查调用链**\n\n从入口看")])).toEqual({
      label: "查调用链",
      streaming: false,
      body: "从入口看",
    });
    expect(
      thinkingLabel([
        thought("这一段已经长到不能放进标题里了，所以标题保持通用，完整的内容留到展开之后再看，避免把一整段推理铺在工具中间。", "streaming"),
      ]).label,
    ).toBe("正在思考");
  });
});

describe("summaryLabel", () => {
  it("concatenates categories, with the first one in its leading form", () => {
    const tools = run(blocksOf([tool("c1", "read"), tool("c2", "read"), tool("c3", "bash"), tool("c4", "edit")])).tools;
    expect(summaryLabel(tools)).toBe("已读取文件运行了命令编辑了一个文件");
    expect(summaryLabel(run(blocksOf([tool("c1", "grep"), tool("c2", "grep")])).tools)).toBe("已搜索");
  });

  it("counts a shell command that only reads or searches as a read or a search", () => {
    const bash = (id: string, command: string) =>
      ({ type: "tool-Bash", toolCallId: id, state: "output-available", input: { command } }) as unknown as UIMessage["parts"][number];
    const tools = run(blocksOf([bash("c1", "sed -n 1,40p a.ts"), bash("c2", "grep -rn foo src"), bash("c3", "pnpm test")])).tools;
    expect(summaryLabel(tools)).toBe("已读取文件搜索了运行了命令");
  });
});
