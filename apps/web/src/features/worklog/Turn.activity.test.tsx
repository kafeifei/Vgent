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
const steer = (id: string, text: string) =>
  ({ type: "data-steer", id, data: { text, messageId: id, receipt: true } }) as UIMessage["parts"][number];

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
  it("folds consecutive scripts and keeps their running state on the group", () => {
    const html = htmlOf([
      bash("loop", 'for f in *.ts; do cat "$f"; done'),
      bash("node", "node -e 'console.log(1)'", "input-available"),
      { type: "text", text: "接下来查看细节" },
      { ...bash("single", "node -e 'console.log(2)'"), input: { command: "node -e 'console.log(2)'", description: "查看组件的渲染细节" } } as UIMessage["parts"][number],
    ], true);
    expect(html).toContain("执行 2 条命令");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("for f in");
    expect(html).toContain("查看组件的渲染细节");
    expect(html.indexOf("执行 2 条命令")).toBeLessThan(html.indexOf("接下来查看细节"));
    expect(html.indexOf("接下来查看细节")).toBeLessThan(html.indexOf("查看组件的渲染细节"));
  });

  it("groups Codex commandExecution records by their inner operation and retains a running indicator", () => {
    const commands = [
      "/bin/zsh -lc 'cat package.json && rg --files apps | head -80'",
      "/bin/zsh -lc 'git status --short && git worktree list --porcelain'",
      "/bin/zsh -lc 'cat apps/desktop/README.md'",
    ];
    const parts = commands.map((command, index) => ({
      type: "dynamic-tool", toolName: "Bash", toolCallId: `codex-${index}`,
      state: index === 2 ? "input-available" : "output-available", input: { command, cwd: "/repo" },
    })) as UIMessage["parts"];
    const html = htmlOf([...parts, bash("build", "/bin/zsh -lc 'pnpm desktop:build'")], true);
    expect(html).toContain("读取 2 次 · 搜索 1 次");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("git worktree list");
    expect(html).not.toContain("cat package.json");
    expect(html).toContain("pnpm desktop:build");
    expect(htmlOf(parts)).toContain("工作了 3 步");
  });

  it("is the process in order: one thought row, looks folded with counts, a command on its own line", () => {
    const html = htmlOf(steps.slice(0, 4), true);
    expect(html).toContain("思考");
    expect(html).toContain("读取 2 次");
    expect(html).not.toContain("sed -n 1,40p");
    expect(html).toContain("pnpm test");
    expect(html).not.toContain("工作了");
    expect(html.indexOf("思考")).toBeLessThan(html.indexOf("读取 2 次"));
    expect(html.indexOf("读取 2 次")).toBeLessThan(html.indexOf("pnpm test"));
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
      output: { metadata: { subagent: { modelId: "actual-child-model" } }, parts: [
        { type: "reasoning", text: "unique-child-thought", state: "streaming" },
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
    expect(html).not.toContain("actual-child-model");
    expect(html).not.toContain("unique-child-thought");
    expect(html).not.toContain("进行中…");

    const detail = renderToStaticMarkup(createElement(ToolDetail, { part: child as ToolPart, onOpenFile: () => {} }));
    expect(detail).toContain("unique-child-search");
    expect(detail).toContain("unique-child-summary");
    expect(detail).toContain("actual-child-model");
    expect(detail).toContain("unique-child-thought");
    expect(detail).toContain("思考中…");
  });

  it("keeps legacy child results readable without inventing their model or reasoning", () => {
    const part = { type: "dynamic-tool", toolName: "explore", toolCallId: "legacy", state: "output-available", input: { prompt: "Inspect" }, output: { parts: [{ type: "text", text: "Legacy result" }] } } as ToolPart;
    const detail = renderToStaticMarkup(createElement(ToolDetail, { part, onOpenFile: () => {} }));
    expect(detail).toContain("未记录");
    expect(detail).toContain("没有可展示的思考记录");
    expect(detail).toContain("Legacy result");
  });

  it("shows a reply written mid-way where it happened", () => {
    const html = htmlOf([tool("c1", "Read"), { type: "text", text: "先这样" } as UIMessage["parts"][number], bash("c2", "pnpm test")], true);
    expect(html.indexOf("c1.ts")).toBeLessThan(html.indexOf("先这样"));
    expect(html.indexOf("先这样")).toBeLessThan(html.indexOf("pnpm test"));
  });
});

describe("a finished turn", () => {
  it.each(["output-error", "output-denied", "output-available"])("keeps failed work visible outside completed folds (%s)", (state) => {
    const failed = { ...bash("failed", "failing-command", state), output: { exitCode: 2 }, errorText: "failed" } as UIMessage["parts"][number];
    const html = htmlOf([bash("c1", "hidden-before"), failed, bash("c2", "hidden-after"), { type: "text", text: "结果说明" }]);
    expect(html).toContain("failing-command");
    expect(html).not.toContain("hidden-before");
    expect(html).not.toContain("hidden-after");
    expect(html.match(/工作了 1 步/g)).toHaveLength(2);
    expect(html).toContain(state === "output-error" ? "失败" : state === "output-denied" ? "已拒绝" : "exit 2");
  });

  it.each([false, true])("keeps a waiting steer actionable outside the fold (applied: %s)", (applied) => {
    const turn = buildTurns([
      { id: "u", role: "user", parts: [{ type: "text", text: "问" }] },
      { id: "a", role: "assistant", parts: [bash("c1", "earlier-work"), steer("s1", "待处理的补充")] },
    ], [{ id: "s1", text: "待处理的补充", mode: "steer", accepted: true, applied, createdAt: "2026-09-27" }], false)[0]!;
    const html = renderToStaticMarkup(createElement(Turn, {
      turn, isLast: true, live: false, dimmed: false,
      actions: { ...actions, sendSteer: () => {} }, allowlist: [], drawings: new Map(),
    }));
    expect(html).toContain("待处理的补充");
    expect(html).toContain("工作了 1 步");
    expect(html).not.toContain("earlier-work");
    expect(html.includes("立即发送")).toBe(!applied);
  });

  it("keeps an accepted user interjection visible after completion and reload, folding only the work around it", () => {
    const parts = [
      bash("before", "inspect-before-steer"),
      steer("s1", "交付规矩存在哪里？"),
      bash("after1", "inspect-after-steer"),
      tool("after2", "Read"),
      { type: "text", text: "规矩存储位置如下" } as UIMessage["parts"][number],
    ];
    expect(htmlOf(parts, true)).toContain("交付规矩存在哪里？");
    // Rebuild from serialized history, with no live queue left after completion.
    const html = htmlOf(JSON.parse(JSON.stringify(parts)) as UIMessage["parts"]);
    expect(html.match(/交付规矩存在哪里？/g)).toHaveLength(1);
    expect(html).toContain('data-steer-id="s1"');
    expect(html).not.toContain("inspect-before-steer");
    expect(html).not.toContain("inspect-after-steer");
    expect(html).not.toContain("after2.ts");
    expect(html.indexOf("工作了 1 步")).toBeLessThan(html.indexOf("交付规矩存在哪里？"));
    expect(html.indexOf("交付规矩存在哪里？")).toBeLessThan(html.indexOf("工作了 2 步"));
    expect(html.indexOf("工作了 2 步")).toBeLessThan(html.indexOf("规矩存储位置如下"));
    expect(html).not.toContain("立即发送");
    expect(html).not.toContain("引导消息");
  });

  it("preserves consecutive interjections, including legacy history, in their original order", () => {
    const html = htmlOf([
      steer("first", "最前面追加"),
      tool("c1", "Read"),
      { type: "data-steer", data: { text: "以前追加的消息" } } as UIMessage["parts"][number],
      steer("last", "连续追加的消息"),
      { type: "text", text: "最终回复" },
    ]);
    const labels = ["最前面追加", "工作了 1 步", "以前追加的消息", "连续追加的消息", "最终回复"];
    for (const label of labels) expect(html.split(label)).toHaveLength(2);
    for (let i = 1; i < labels.length; i++) {
      expect(html.indexOf(labels[i - 1]!)).toBeLessThan(html.indexOf(labels[i]!));
    }
  });

  it("keeps an interjection visible when the turn stops on a tool without a final reply", () => {
    const html = htmlOf([tool("c1", "Read"), steer("s1", "停在这里"), bash("c2", "unfinished-command", "input-available")]);
    expect(html).toContain("停在这里");
    expect(html).not.toContain("unfinished-command");
    expect(html.match(/工作了 1 步/g)).toHaveLength(2);
  });

  it("folds the whole process behind 工作了 N 步 and shows the reply under it", () => {
    const html = htmlOf(steps);
    expect(html).toContain("工作了 3 步");
    expect(html).toContain("改完了");
    expect(html).not.toContain("pnpm test");
    expect(html).not.toContain("读取 2 次");
    expect(html).not.toContain("先看看");
    expect(html.indexOf("工作了 3 步")).toBeLessThan(html.indexOf("改完了"));
  });

  it("does not fold a turn that only replied", () => {
    const html = htmlOf([reasoning("想"), { type: "text", text: "就这样" } as UIMessage["parts"][number]]);
    expect(html).not.toContain("工作了");
    expect(html).toContain("就这样");
  });
});
