import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "@/lib/types";
import { WorkLog } from "./WorkLog";

const base: ThreadSummary = {
  id: "thread-1",
  title: "新任务",
  projectId: "project-1",
  engine: "claude-code",
  status: "idle",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  pendingApprovals: 0,
};

const htmlOf = (thread: ThreadSummary) => renderToStaticMarkup(createElement(WorkLog, {
  thread,
  messages: [],
  live: false,
  error: undefined,
  actions: {
    respondToApproval: () => {}, alwaysAllow: () => {}, answerQuestions: () => {},
    openFile: () => {}, inspect: () => {}, fork: () => {}, restoreLatest: () => {},
  },
  allowlist: [],
  client: { getSetupLog: vi.fn() },
}));

describe("worktree preparation in the chat log", () => {
  it("shows worktree creation without labeling it as an empty conversation", () => {
    const html = htmlOf({ ...base, workspaceState: "creating" });
    expect(html).toContain("正在创建 worktree");
    expect(html).not.toContain("还没有内容");
  });

  it("shows setup while waiting for the first turn", () => {
    const html = htmlOf({ ...base, workspace: {
      mode: "worktree", path: "/tmp/worktree", branch: "vgent/thread-1", baseCommit: "abc",
      setup: { status: "running", startedAt: base.createdAt },
    } });
    expect(html).toContain("正在初始化 worktree");
    expect(html).not.toContain("还没有内容");
  });

  it("shows creation errors in the conversation", () => {
    const html = htmlOf({ ...base, workspaceState: "failed", error: "缺少提交" });
    expect(html).toContain("创建 worktree 失败");
    expect(html).toContain("缺少提交");
    expect(html).not.toContain("还没有内容");
  });
});
