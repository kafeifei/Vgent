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
      created: { startedAt: base.createdAt, finishedAt: "2026-01-01T00:00:02.400Z" },
      setup: { status: "running", startedAt: base.createdAt, command: "pnpm install" },
    } });
    expect(html).toContain("已创建 worktree");
    expect(html).toContain("用时 2s");
    expect(html).toContain("正在运行 setup 脚本");
    // Cursor's rows: what is happening, not the commands themselves.
    expect(html).not.toContain("pnpm install");
    expect(html).not.toContain("还没有内容");
  });

  it("says why setup failed, and nothing about a setup that went fine", () => {
    const worktree = { mode: "worktree" as const, path: "/tmp/worktree", branch: "vgent/thread-1", baseCommit: "abc" };
    const failed = htmlOf({ ...base, workspace: { ...worktree,
      setup: { status: "failed", startedAt: base.createdAt, finishedAt: "2026-01-01T00:01:05.000Z", exitCode: 1, error: "setup 脚本失败，退出码 1" },
    } });
    expect(failed).toContain("运行 setup 脚本失败");
    expect(failed).toContain("用时 1m 5s");
    expect(failed).toContain("setup 脚本失败，退出码 1");
    const ok = htmlOf({ ...base, workspace: { ...worktree,
      setup: { status: "ok", startedAt: base.createdAt, finishedAt: "2026-01-01T00:00:00.500Z", exitCode: 0 },
    } });
    expect(ok).toContain("已运行 setup 脚本");
    // Under a second is not worth a number.
    expect(ok).not.toContain("用时");
    expect(ok).not.toContain("退出码");
  });

  it("shows creation errors in the conversation", () => {
    const html = htmlOf({ ...base, workspaceState: "failed", error: "缺少提交" });
    expect(html).toContain("创建 worktree 失败");
    expect(html).toContain("缺少提交");
    expect(html).not.toContain("还没有内容");
  });
});
