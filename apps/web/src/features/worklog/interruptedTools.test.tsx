import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { findToolPart, ToolDetail } from "@/features/rightpane/ToolDetail";
import { processSectionsOf } from "./activity";
import { buildTurns } from "./turns";
import { isToolStreaming } from "./toolMeta";
import { ToolRow } from "./ToolRow";

const partial: UIMessage["parts"][number] = {
  type: "dynamic-tool", toolName: "coder", toolCallId: "child", state: "output-available", preliminary: true,
  input: { task: "检查排队测试" },
  output: { parts: [
    { type: "reasoning", text: "中断前的思考", state: "streaming" },
    { type: "text", text: "已检查部分测试" },
  ], metadata: { subagent: { modelId: "test-model" } } },
};
const history = (ended: boolean, part = partial): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text: "检查附件排队" }],
    ...(ended ? { metadata: { turnEnd: { status: "interrupted", reason: "服务已重启" } } } : {}) },
  { id: "a1", role: "assistant", parts: [part, { type: "reasoning", text: "主代理最后的思考", state: "streaming" }] },
];
const rowHtml = (messages: UIMessage[]) => renderToStaticMarkup(createElement(ToolRow, {
  part: findToolPart(messages, "child")!, onOpenFile: () => {}, onInspect: () => {},
}));
const detailHtml = (messages: UIMessage[]) => renderToStaticMarkup(createElement(ToolDetail, {
  part: findToolPart(messages, "child"), onOpenFile: () => {},
}));

describe("interrupted tool display", () => {
  it("shows a recovered preliminary result as interrupted, preserving its partial transcript", () => {
    const messages = JSON.parse(JSON.stringify(history(true))) as UIMessage[];
    const original = JSON.stringify(messages);
    const turn = buildTurns(messages)[0]!;
    const part = findToolPart(messages, "child")!;
    expect(part).toMatchObject({ interrupted: true, state: "output-available", preliminary: true, output: partial.output });
    expect(turn.blocks[0]).toMatchObject({ part });
    expect(processSectionsOf(turn.blocks)[0]?.kind).toBe("attention");
    expect(isToolStreaming(part)).toBe(false);
    expect(turn.blocks[1]).toMatchObject({ kind: "reasoning", part: { state: "done" } });
    const row = rowHtml(messages);
    expect(row).toContain("已中断");
    expect(row).not.toContain("运行中");
    expect(row).not.toContain("animate-spin");
    const detail = detailHtml(messages);
    for (const text of ["已中断", "部分输出", "中断前的思考", "已检查部分测试", "test-model"]) expect(detail).toContain(text);
    for (const text of ["运行中", "进行中…", "思考中…", "已完成"]) expect(detail).not.toContain(text);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("keeps the current partial result live even when an earlier turn was interrupted", () => {
    const messages = [...history(true, { ...partial, toolCallId: "old" }), ...history(false).map(m => ({ ...m, id: `${m.id}-new` }))];
    const part = findToolPart(messages, "child")!;
    expect(part).not.toHaveProperty("interrupted");
    expect(isToolStreaming(part)).toBe(true);
    expect(rowHtml(messages)).toContain("运行中");
    expect(detailHtml(messages)).toContain("思考中…");
    expect(detailHtml(messages)).toContain("进行中…");
  });

  it("does not relabel a final result or a resumable approval as interrupted", () => {
    expect(findToolPart(history(true, { ...partial, preliminary: false }), "child")).not.toHaveProperty("interrupted");
    expect(detailHtml(history(true, { ...partial, preliminary: false }))).toContain("已完成");
    const approval: UIMessage["parts"][number] = {
      type: "dynamic-tool", toolName: "bash", toolCallId: "child", state: "approval-requested",
      input: { command: "pnpm test" }, approval: { id: "approve" },
    };
    expect(findToolPart(history(false, approval), "child")).toEqual(approval);
    expect(detailHtml(history(false, approval))).toContain("等待审批");
  });

  it.each(["input-streaming", "input-available"] as const)("does not animate an abandoned %s call", state => {
    const messages = history(true, { type: "dynamic-tool", toolName: "coder", toolCallId: "child", state, input: { task: "检查" } });
    expect(rowHtml(messages)).toContain("已中断");
    expect(rowHtml(messages)).not.toContain("animate-spin");
    expect(detailHtml(messages)).not.toContain("运行中");
  });
});
