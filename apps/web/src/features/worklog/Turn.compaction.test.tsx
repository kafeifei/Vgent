import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ThreadMessageMetadata } from "@/lib/types";
import { Turn, type TurnActions } from "./Turn";
import { buildTurns } from "./turns";

const actions: TurnActions = {
  respondToApproval() {}, alwaysAllow() {}, answerQuestions() {}, openFile() {},
  inspect() {}, fork() {}, restoreLatest() {},
};
const request = (metadata: ThreadMessageMetadata): UIMessage => ({
  id: "compact", role: "user", parts: [{ type: "text", text: "/compact" }], metadata,
});
const completedRun: NonNullable<ThreadMessageMetadata["run"]> = {
  id: "run", engine: "claude-code", startedAt: "2026-09-29T19:04:34Z",
  endedAt: "2026-09-29T19:05:46Z", stopReason: "response", finishReason: "stop",
};
const htmlOf = (message: UIMessage, live = false, parts: UIMessage["parts"] = [{ type: "step-start" }]) => {
  const turn = buildTurns([message, { id: "assistant", role: "assistant", parts }])[0]!;
  return renderToStaticMarkup(<Turn turn={turn} isLast live={live} dimmed={false} actions={actions} allowlist={[]} drawings={new Map()} />);
};

describe("native /compact", () => {
  it.each([
    { compactRequested: { at: "now" } },
    { compacted: { before: 14, at: "now" } },
  ])("shows new and legacy requests as pending without a user bubble or fake success", (metadata) => {
    const html = htmlOf(request(metadata), true);
    expect(html).toContain("正在压缩上下文…");
    for (const text of ["上下文已压缩", "思考中", "原 14 条", "/compact", "bg-bg-elevated"]) expect(html).not.toContain(text);
  });

  it.each([
    { compactRequested: { at: "now" }, run: completedRun },
    { compacted: { before: 14, at: "now" }, run: completedRun },
  ])("recognizes a successful native command with no reply, including saved legacy turns", (metadata) => {
    const html = htmlOf(request(metadata));
    expect(html).toContain("上下文已压缩");
    expect(html).not.toContain("模型没有返回内容");
    expect(html).not.toContain("未确认");
    expect(html).not.toContain("原 14 条");
  });

  it.each(["error", "interrupted"] as const)("does not report success for a %s turn", (status) => {
    const html = htmlOf(request({ compactRequested: { at: "now" }, turnEnd: { status, reason: "测试结束原因" } }));
    expect(html).toContain(status === "error" ? "上下文压缩失败" : "上下文压缩已中断");
    expect(html).not.toContain("上下文已压缩");
    expect(html).not.toContain("模型没有返回内容");
  });

  it("does not infer success from an empty assistant message or incomplete finish", () => {
    for (const run of [undefined, { ...completedRun, finishReason: "length" }]) {
      const html = htmlOf(request({ compactRequested: { at: "now" }, ...(run ? { run } : {}) }));
      expect(html).toContain("压缩结束，未确认结果");
      expect(html).not.toContain("上下文已压缩");
    }
  });

  it("shows a reported compaction once even while the turn is finishing", () => {
    const html = htmlOf(request({ compactRequested: { at: "now" } }), true, [{
      type: "data-compaction", data: { trigger: "manual", tokensBefore: 504206, tokensAfter: 7730 },
    }]);
    expect(html.match(/上下文已压缩/g)).toHaveLength(1);
    expect(html).toContain("504k → 7.7k");
    expect(html).not.toContain("正在压缩");
  });

  it("keeps the in-house summary and its original message count", () => {
    const html = htmlOf({
      id: "summary", role: "user", parts: [{ type: "text", text: "上下文摘要正文" }],
      metadata: { compacted: { before: 14, at: "now" } },
    }, false, [{ type: "text", text: "收到" }]);
    expect(html).toContain("上下文已压缩（原 14 条消息）");
    expect(html).toContain("上下文摘要正文");
  });
});
