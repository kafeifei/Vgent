import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { contextUsage } from "@/features/composer/contextUsage";
import { SummaryPanel } from "@/features/rightpane/SummaryPanel";
import type { ThreadMessageMetadata, ThreadSummary } from "@/lib/types";
import { WorkLog } from "./WorkLog";

const thread: ThreadSummary = {
  id: "thread-1",
  title: "登录页",
  projectId: "project-1",
  engine: "vgent",
  status: "idle",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  messageCount: 5,
  pendingApprovals: 0,
};

const say = (id: string, role: "user" | "assistant", text: string, metadata?: ThreadMessageMetadata): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text }],
  ...(metadata != null ? { metadata } : {}),
});

const history: UIMessage[] = [
  say("u1", "user", "把登录页改成中文"),
  say("a1", "assistant", "改好了".repeat(2_000), { usage: { inputTokens: 300_000 } }),
  say("u2", "user", "再加个按钮"),
  say("a2", "assistant", "加好了", { usage: { inputTokens: 310_000 } }),
  say("m1", "user", "上下文已压缩，以下是之前对话的摘要：\n\n登录页已改成中文，按钮已加。", { compacted: { before: 2, at: "2026-09-30T05:04:00.000Z", keptFrom: "u2" } }),
];

const htmlOf = (messages: UIMessage[], overrides: Partial<ThreadSummary> = {}) =>
  renderToStaticMarkup(
    createElement(WorkLog, {
      thread: { ...thread, ...overrides },
      messages,
      live: false,
      error: undefined,
      actions: {
        respondToApproval: () => {}, alwaysAllow: () => {}, answerQuestions: () => {},
        openFile: () => {}, inspect: () => {}, fork: () => {}, restoreLatest: () => {},
      },
      allowlist: [],
      client: { getSetupLog: vi.fn() },
    }),
  );

describe("压缩 in the log", () => {
  it("keeps every earlier message and shows the summary as one line, not as a message", () => {
    const html = htmlOf(history);
    expect(html).toContain("把登录页改成中文");
    expect(html).toContain("再加个按钮");
    expect(html).toContain("上下文已压缩");
    expect(html).not.toContain("登录页已改成中文，按钮已加");
  });

  it("says a summary is being written, and why one failed", () => {
    expect(htmlOf(history.slice(0, 4), { compaction: { startedAt: "2026-09-30T05:03:30.000Z" } })).toContain("正在压缩上下文…");
    const failed = htmlOf(history.slice(0, 4), { compaction: { startedAt: "2026-09-30T05:03:30.000Z", error: "upstream 500" } });
    expect(failed).toContain("上下文压缩失败：upstream 500");
    expect(failed).not.toContain("正在压缩上下文…");
  });
});

describe("the summary in the right pane", () => {
  it("shows what the model reads instead of the history, without the lead-in", () => {
    const html = renderToStaticMarkup(createElement(SummaryPanel, { messages: history, messageId: "m1" }));
    expect(html).toContain("登录页已改成中文，按钮已加。");
    expect(html).not.toContain("以下是之前对话的摘要");
    expect(renderToStaticMarkup(createElement(SummaryPanel, { messages: history, messageId: "u1" }))).toContain("这条摘要已经不在了");
  });
});

describe("the ring after 压缩", () => {
  it("measures the summary and the turns it kept, not the last count taken before it", () => {
    const usage = contextUsage(history);
    expect(usage.source).toBe("estimate");
    expect(usage.tokens).toBeLessThan(100);
    // The next turn's own count takes over again.
    expect(contextUsage([...history, say("u3", "user", "继续"), say("a3", "assistant", "好", { usage: { inputTokens: 9_000 } })])).toEqual({ tokens: 9_000, source: "usage" });
  });
});
