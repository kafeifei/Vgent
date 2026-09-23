import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Turn, type TurnActions } from "./Turn";
import { buildTurns } from "./turns";

const actions: TurnActions = {
  respondToApproval: () => {},
  alwaysAllow: () => {},
  answerQuestions: () => {},
  openFile: () => {},
  inspect: () => {},
  fork: () => {},
  restoreLatest: () => {},
};

const tool = (id: string, name: string, state = "output-available") =>
  ({
    type: `tool-${name}`,
    toolCallId: id,
    state,
    input: { file_path: `${id}.ts`, command: "pnpm test", pattern: "x" },
  }) as unknown as UIMessage["parts"][number];

const htmlOf = (parts: UIMessage["parts"], live = false) => {
  const turn = buildTurns([{ id: "u", role: "user", parts: [{ type: "text", text: "问" }] }, { id: "a", role: "assistant", parts }])[0]!;
  return renderToStaticMarkup(
    createElement(Turn, { turn, isLast: live, live, dimmed: false, actions, allowlist: [], drawings: new Map() }),
  );
};

describe("thinking sits on the activity title", () => {
  const steps = [
    tool("c1", "read"),
    tool("c2", "read"),
    { type: "reasoning", text: "想一下", state: "done" } as UIMessage["parts"][number],
    tool("c3", "bash"),
    { type: "text", text: "改完了" },
    tool("c4", "edit"),
  ];

  it("collapses a finished run into one category sentence, and does not leave the thought between the tools", () => {
    const html = htmlOf(steps);
    expect(html).toContain("已读取文件运行了命令");
    expect(html).toContain("改完了");
    expect(html).toContain("c4.ts");
    expect(html).not.toContain("想一下");
    expect(html).not.toContain("c1.ts");
    expect(html).not.toContain(">$</span>");
  });

  it("shows the thought as the title above the tools while the turn is still going", () => {
    const html = htmlOf([
      tool("c1", "read"),
      tool("c2", "read"),
      { type: "reasoning", text: "想一下", state: "done" } as UIMessage["parts"][number],
    ], true);
    const title = html.indexOf("想一下");
    const fold = html.indexOf("已探索");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(fold).toBeGreaterThan(title);
    expect(html.indexOf("想一下", title + "想一下".length)).toBe(-1);
    expect(html).not.toContain("已读取文件");
  });

  it("replaces that title with the tool that is running", () => {
    const html = htmlOf(
      [
        tool("c1", "read"),
        { type: "reasoning", text: "想一下", state: "done" } as UIMessage["parts"][number],
        tool("c3", "bash", "input-available"),
      ],
      true,
    );
    expect(html).not.toContain("想一下");
    expect(html).toContain("正在运行命令");
    // The command is on its row and nowhere else.
    expect(html.indexOf("pnpm test")).toBe(html.lastIndexOf("pnpm test"));
  });

  it("folds consecutive looks into one 已探索 line while the turn is going, and leaves a command on its own", () => {
    const bash = (id: string, command: string) =>
      ({ type: "tool-Bash", toolCallId: id, state: "output-available", input: { command } }) as unknown as UIMessage["parts"][number];
    const html = htmlOf(
      [
        bash("c1", "cd /repo; sed -n 100,140p src/app.ts"),
        bash("c2", "grep -n runs.start src/app.ts"),
        tool("c3", "read"),
        bash("c4", "pnpm test"),
      ],
      true,
    );
    expect(html).toContain("已探索");
    expect(html).toContain("2 次读取 · 1 次搜索");
    expect(html).not.toContain("sed -n 100,140p");
    expect(html).toContain("pnpm test");
  });

  it("says 正在探索 while a look in the fold is still running", () => {
    const html = htmlOf(
      [
        tool("c1", "read"),
        tool("c2", "read", "input-available"),
      ],
      true,
    );
    expect(html).toContain("正在探索");
    expect(html).toContain("2 次读取");
  });
});
