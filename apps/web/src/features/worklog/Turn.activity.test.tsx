import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Turn, type TurnActions } from "./Turn";
import { ToolDetail } from "@/features/rightpane/ToolDetail";
import type { ToolPart } from "./toolMeta";
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
  ({ type: `tool-${name}`, toolCallId: id, state, input: { file_path: `${id}.ts`, pattern: "x" } }) as unknown as UIMessage["parts"][number];
const bash = (id: string, command: string, state = "output-available") =>
  ({ type: "tool-Bash", toolCallId: id, state, input: { command } }) as unknown as UIMessage["parts"][number];
const reasoning = (text: string, state: "streaming" | "done" = "done") =>
  ({ type: "reasoning", text, state }) as UIMessage["parts"][number];

const htmlOf = (parts: UIMessage["parts"], live = false) => {
  const turn = buildTurns([{ id: "u", role: "user", parts: [{ type: "text", text: "问" }] }, { id: "a", role: "assistant", parts }])[0]!;
  return renderToStaticMarkup(
    createElement(Turn, { turn, isLast: live, live, dimmed: false, actions, allowlist: [], drawings: new Map() }),
  );
};

const steps = [
  reasoning("先看看"),
  tool("c1", "Read"),
  bash("c2", "cd /repo; sed -n 1,40p src/app.ts"),
  bash("c3", "pnpm test"),
  { type: "text", text: "改完了" } as UIMessage["parts"][number],
];

describe("a running turn", () => {
  it("is the process in order: one thought row, looks folded with counts, a command on its own line", () => {
    const html = htmlOf(steps.slice(0, 4), true);
    expect(html).toContain("思考");
    expect(html).toContain("读取 2 个文件");
    expect(html).not.toContain("sed -n 1,40p");
    expect(html).toContain("pnpm test");
    expect(html).not.toContain("工作了");
    expect(html.indexOf("思考")).toBeLessThan(html.indexOf("读取 2 个文件"));
    expect(html.indexOf("读取 2 个文件")).toBeLessThan(html.indexOf("pnpm test"));
  });

  it("says 思考中… while the thought at its end is still going", () => {
    expect(htmlOf([tool("c1", "Read"), reasoning("想一下", "streaming")], true)).toContain("思考中…");
    expect(htmlOf([tool("c1", "Read"), reasoning("想完了")], true)).toContain("思考中…");
    expect(htmlOf([reasoning("想完了"), tool("c1", "Read")], true)).not.toContain("思考中…");
  });

  it("shows a subagent as a single icon row, not its streamed transcript", () => {
    const child = {
      type: "tool-explore",
      toolCallId: "child",
      state: "output-available",
      preliminary: true,
      input: { prompt: "查找相关文件" },
      output: { parts: [
        { type: "tool-grep", toolCallId: "nested", state: "output-available", input: { pattern: "unique-child-search" } },
        { type: "text", text: "unique-child-summary" },
      ] },
    } as unknown as UIMessage["parts"][number];
    const html = htmlOf([child], true);
    expect(html).toContain("子代理·探索");
    expect(html).toContain("lucide-bot");
    expect(html).toContain("运行中");
    expect(html).not.toContain("查找相关文件");
    expect(html).not.toContain("unique-child-search");
    expect(html).not.toContain("unique-child-summary");
    expect(html).not.toContain("进行中…");

    const detail = renderToStaticMarkup(createElement(ToolDetail, { part: child as ToolPart, onOpenFile: () => {} }));
    expect(detail).toContain("unique-child-search");
    expect(detail).toContain("unique-child-summary");
  });

  it("shows a reply written mid-way where it happened", () => {
    const html = htmlOf([tool("c1", "Read"), { type: "text", text: "先这样" } as UIMessage["parts"][number], bash("c2", "pnpm test")], true);
    expect(html.indexOf("c1.ts")).toBeLessThan(html.indexOf("先这样"));
    expect(html.indexOf("先这样")).toBeLessThan(html.indexOf("pnpm test"));
  });
});

describe("a finished turn", () => {
  it("folds the whole process behind 工作了 N 步 and shows the reply under it", () => {
    const html = htmlOf(steps);
    expect(html).toContain("工作了 3 步");
    expect(html).toContain("改完了");
    expect(html).not.toContain("pnpm test");
    expect(html).not.toContain("读取 2 个文件");
    expect(html).not.toContain("先看看");
    expect(html.indexOf("工作了 3 步")).toBeLessThan(html.indexOf("改完了"));
  });

  it("does not fold a turn that only replied", () => {
    const html = htmlOf([reasoning("想"), { type: "text", text: "就这样" } as UIMessage["parts"][number]]);
    expect(html).not.toContain("工作了");
    expect(html).toContain("就这样");
  });
});
