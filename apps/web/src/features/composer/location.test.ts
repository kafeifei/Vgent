import { describe, expect, it } from "vitest";
import type { ChangesSnapshot, ThreadSummary, ThreadWorkspace } from "@/lib/types";
import { taskBranch, taskLocation } from "./location";

const thread = (workspace?: ThreadWorkspace): ThreadSummary => ({
  version: 1,
  id: "t1",
  projectId: "p1",
  title: "任务",
  engine: "vgent",
  status: "idle",
  createdAt: "2026-09-19T00:00:00.000Z",
  updatedAt: "2026-09-19T00:00:00.000Z",
  messageCount: 0,
  pendingApprovals: 0,
  ...(workspace != null ? { workspace } : {}),
});

const worktree = (extra: Partial<ThreadWorkspace> = {}): ThreadWorkspace => ({
  mode: "worktree",
  path: "/data/worktrees/t1",
  branch: "vgent/abcd1234",
  baseCommit: "c0ffee",
  ...extra,
});

const snapshot = (branch: string | null, repoPath = "/repo"): ChangesSnapshot => ({ repoPath, branch, files: [] });

describe("taskBranch", () => {
  it("names the worktree's own branch, snapshot or not", () => {
    expect(taskBranch(thread(worktree()), null)).toBe("vgent/abcd1234");
    expect(taskBranch(thread(worktree()), snapshot("main"))).toBe("vgent/abcd1234");
  });

  it("falls back to the checkout's current branch for a 主目录 task", () => {
    expect(taskBranch(thread(), snapshot("feature/x"))).toBe("feature/x");
  });

  it("has nothing to show on a detached HEAD, or before the snapshot lands", () => {
    expect(taskBranch(thread(), snapshot(null))).toBeNull();
    expect(taskBranch(thread(), null)).toBeNull();
  });
});

describe("taskLocation", () => {
  it("spells out a worktree task and carries its directory", () => {
    expect(taskLocation(thread(worktree()), null)).toEqual({ label: "本机 · worktree", path: "/data/worktrees/t1" });
  });

  it("says so when the worktree directory was reclaimed", () => {
    expect(taskLocation(thread(worktree({ reclaimed: true })), null).label).toBe("本机 · worktree（已回收）");
  });

  it("calls a 无项目 task's directory what it is: temporary, and nobody's checkout", () => {
    expect(taskLocation({ ...thread(), projectId: "no-project" }, null)).toEqual({ label: "本机 · 临时目录", path: null });
  });

  it("points a 主目录 task at the repo the snapshot came from", () => {
    expect(taskLocation(thread(), snapshot("main", "/repo"))).toEqual({ label: "本机 · 主目录", path: "/repo" });
    expect(taskLocation(thread(), null)).toEqual({ label: "本机 · 主目录", path: null });
  });
});
