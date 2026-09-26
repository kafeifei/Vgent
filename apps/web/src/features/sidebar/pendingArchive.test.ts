import { describe, expect, it } from "vitest";
import type { ThreadSummary, ThreadWorkspace } from "@/lib/types";
import { settledPendingArchive, withPendingArchive } from "./pendingArchive";

const worktree = (extra: Partial<ThreadWorkspace> = {}): ThreadWorkspace => ({
  mode: "worktree",
  path: "/data/worktrees/t",
  branch: "vgent/t",
  baseCommit: "abc1234",
  ...extra,
});

const thread = (id: string, extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    id,
    projectId: "p1",
    title: id,
    engine: "claude-code",
    status: "idle",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    messageCount: 0,
    pendingApprovals: 0,
    ...extra,
  }) as ThreadSummary;

describe("withPendingArchive", () => {
  it("moves a task into 已归档 on the click, 归档中 while it has a worktree to reclaim", () => {
    const [withWorktree, plain] = withPendingArchive(
      [thread("a", { workspace: worktree() }), thread("b")],
      new Map([
        ["a", true],
        ["b", true],
      ]),
    );
    expect(withWorktree?.archivedAt).toEqual(expect.any(String));
    expect(withWorktree?.transition).toBe("archiving");
    expect(plain?.archivedAt).toEqual(expect.any(String));
    expect(plain?.transition).toBeUndefined();
  });

  it("takes a task out of 已归档 on the click, 恢复中 while its worktree has to come back", () => {
    const archivedAt = "2026-09-24T01:00:00.000Z";
    const [reclaimed] = withPendingArchive(
      [thread("a", { archivedAt, workspace: worktree({ reclaimed: true, snapshotPath: "/data/snapshots/a/s" }) })],
      new Map([["a", false]]),
    );
    expect(reclaimed?.archivedAt).toBeUndefined();
    expect(reclaimed?.transition).toBe("unarchiving");
  });

  it("leaves the server's word alone once it says the same", () => {
    const moved = thread("a", { archivedAt: "2026-09-24T01:00:00.000Z", transition: "archiving" });
    const threads = [moved, thread("b")];
    expect(withPendingArchive(threads, new Map([["a", true]]))[0]).toBe(moved);
    expect(withPendingArchive(threads, new Map())).toBe(threads);
  });
});

describe("settledPendingArchive", () => {
  it("drops a move once the snapshot shows the task on that side, and one whose task is gone", () => {
    const pending = new Map([
      ["a", true],
      ["b", false],
      ["gone", true],
    ]);
    const next = settledPendingArchive(pending, [thread("a", { archivedAt: "2026-09-24T01:00:00.000Z" }), thread("b", { archivedAt: "x" })]);
    expect([...next.entries()]).toEqual([["b", false]]);
  });

  it("hands back the same map when nothing settled, so the state does not churn", () => {
    const pending = new Map([["a", true]]);
    expect(settledPendingArchive(pending, [thread("a")])).toBe(pending);
  });
});
