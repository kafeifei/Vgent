import { describe, expect, it } from "vitest";
import type { Project, ThreadStatus, ThreadSummary } from "@/lib/types";
import { groupThreads } from "./grouping";

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

  it("groups by status into 进行中 / 待处理 / 已完成 with counts", () => {
    const groups = groupThreads(threads, projects, "status", NOW);
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["进行中", 1],
      ["待处理", 1],
      ["已完成", 2],
    ]);
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
