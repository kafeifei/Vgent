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

const commands = (prefix: string, count: number): UIMessage["parts"] =>
  Array.from({ length: count }, (_, index) => ({
    type: "tool-Bash", toolCallId: `${prefix}-${index}`, state: "output-available",
    input: { command: `hidden-${prefix}-${index}` }, output: { exitCode: 0 },
  }));

const process: UIMessage["parts"] = [
  { type: "text", text: "首段说明" },
  ...commands("before", 11),
  { type: "text", text: "中段说明" },
  ...commands("after", 18),
];

const history = (parts: UIMessage["parts"], turnEnd?: { status: "interrupted" | "error"; reason: string }): UIMessage[] => [
  { id: "u", role: "user", parts: [{ type: "text", text: "检查任务" }], metadata: turnEnd == null ? {} : { turnEnd } },
  { id: "a", role: "assistant", parts },
];

const replay = (messages: UIMessage[]) => {
  const turns = buildTurns(JSON.parse(JSON.stringify(messages)) as UIMessage[]);
  return renderToStaticMarkup(createElement(Turn, {
    turn: turns[0]!, isLast: turns.length === 1, live: false, dimmed: false,
    actions, allowlist: [], drawings: new Map(),
  }));
};

const expectVisibleProcess = (html: string) => {
  const labels = ["首段说明", "工作了 11 步", "中段说明", "工作了 18 步"];
  for (const label of labels) expect(html.split(label)).toHaveLength(2);
  for (let index = 1; index < labels.length; index++) {
    expect(html.indexOf(labels[index - 1]!)).toBeLessThan(html.indexOf(labels[index]!));
  }
  expect(html.match(/工作了 \d+ 步/g)).toHaveLength(2);
  expect(html).not.toContain("hidden-before-");
  expect(html).not.toContain("hidden-after-");
};

describe("replayed turn text boundaries", () => {
  it("keeps both explanations visible after a service restart without a final reply", () => {
    const html = replay(history(process, { status: "interrupted", reason: "服务已重启" }));
    expectVisibleProcess(html);
    expect(html).toContain("服务已重启");
  });

  it("keeps intermediate text and the final reply visible after normal completion", () => {
    const html = replay(history([...process, { type: "text", text: "最终回复" }]));
    expectVisibleProcess(html);
    expect(html).toContain("最终回复");
    expect(html.indexOf("工作了 18 步")).toBeLessThan(html.indexOf("最终回复"));
  });

  it("keeps explanations visible in an older failed turn", () => {
    const html = replay([
      ...history(process, { status: "error", reason: "历史错误" }),
      { id: "next-u", role: "user", parts: [{ type: "text", text: "继续" }] },
      { id: "next-a", role: "assistant", parts: [{ type: "text", text: "新一轮回复" }] },
    ]);
    expectVisibleProcess(html);
    expect(html).toContain("历史错误");
    expect(html).not.toContain("新一轮回复");
  });

  it("keeps explanations visible in manually stopped history", () => {
    const html = replay(history(process, { status: "interrupted", reason: "用户已停止" }));
    expectVisibleProcess(html);
    expect(html).toContain("用户已停止");
  });

  it("does not hide earlier text when reasoning is the last part", () => {
    const html = replay(history([
      ...process,
      { type: "text", text: "思考前的正文" },
      { type: "reasoning", text: "尚未完成的思考", state: "done" },
    ], { status: "interrupted", reason: "服务已重启" }));
    expectVisibleProcess(html);
    expect(html).toContain("思考前的正文");
    expect(html.indexOf("工作了 18 步")).toBeLessThan(html.indexOf("思考前的正文"));
    expect(html.indexOf("思考前的正文")).toBeLessThan(html.indexOf("思考</"));
  });
});
