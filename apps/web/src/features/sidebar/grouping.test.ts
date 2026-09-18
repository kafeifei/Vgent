import { describe, expect, it } from "vitest";
import type { Project, ThreadStatus, ThreadSummary } from "@/lib/types";
import { groupThreads, needsReview } from "./grouping";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const project = (id: string, name: string): Project => ({ id, name, repoPath: `/repos/${name}`, createdAt: ago(10 * DAY) });

const thread = (id: string, projectId: string, status: ThreadStatus, updatedAt: string): ThreadSummary =>
  ({
    id,
    projectId,
    title: id,
    engine: "claude-code",
    permissionMode: "allow-reads",
    status,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    pendingApprovals: 0,
    version: 1,
  }) as ThreadSummary;

const projects = [project("p1", "vgent"), project("p2", "freecode")];
const threads = [
  thread("t1", "p1", "running", ago(HOUR)),
  thread("t2", "p1", "awaiting-approval", ago(2 * HOUR)),
  thread("t3", "p2", "idle", ago(3 * DAY)),
  thread("t4", "p2", "error", ago(30 * DAY)),
];

describe("groupThreads", () => {
  it("groups by project in project order and keeps threads newest-first", () => {
    const groups = groupThreads(threads, projects, "project", NOW);
    expect(groups.map((group) => group.title)).toEqual(["vgent", "freecode"]);
    expect(groups[0]?.threads.map((entry) => entry.id)).toEqual(["t1", "t2"]);
  });

  it("groups by status into the five buckets, with 失败 counting as 待处理", () => {
    const groups = groupThreads(threads, projects, "status", NOW);
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["进行中", 1],
      ["待处理", 2],
      ["已完成", 1],
    ]);
  });

  it("待验收: idle, has changes, nothing decided yet", () => {
    const pending = { ...thread("t5", "p1", "idle", ago(HOUR)), changeStats: { files: 2, additions: 3, deletions: 1 } };
    const settled = { ...pending, id: "t6", outcome: { kind: "committed" as const, at: ago(HOUR) } };
    const clean = { ...thread("t7", "p1", "idle", ago(HOUR)), changeStats: { files: 0, additions: 0, deletions: 0 } };

    expect(needsReview(pending)).toBe(true);
    expect(needsReview(settled)).toBe(false);
    expect(needsReview(clean)).toBe(false);

    const groups = groupThreads([pending, settled, clean], projects, "status", NOW);
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["待验收", 1],
      ["已完成", 2],
    ]);
  });

  it("collects archived tasks into one folded group at the bottom of every grouping", () => {
    const archived = { ...thread("t8", "p1", "idle", ago(HOUR)), archivedAt: ago(HOUR) };
    for (const grouping of ["project", "status", "updated"] as const) {
      const groups = groupThreads([...threads, archived], projects, grouping, NOW);
      const last = groups.at(-1);
      expect(last).toMatchObject({ key: "archived", title: "已归档", count: 1, collapsible: true });
      // And it appears nowhere else.
      expect(groups.slice(0, -1).flatMap((group) => group.threads.map((entry) => entry.id))).not.toContain("t8");
    }
  });

  it("groups by update time into day buckets", () => {
    const groups = groupThreads(threads, projects, "updated", NOW);
    expect(groups.map((group) => group.title)).toEqual(["今天", "本周", "更早"]);
  });

  it("keeps threads whose project the server no longer lists", () => {
    const groups = groupThreads([thread("t9", "gone", "idle", ago(HOUR))], projects, "project", NOW);
    expect(groups).toEqual([expect.objectContaining({ title: "未知项目" })]);
  });
});
