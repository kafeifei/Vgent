import type { Project, ThreadStatus, ThreadSummary } from "@/lib/types";

export type Grouping = "project" | "status" | "updated";

export const GROUPING_LABELS: Record<Grouping, string> = {
  project: "按项目",
  status: "按状态",
  updated: "按更新时间",
};

export interface ThreadGroup {
  key: string;
  title: string;
  /** Shown after the title when the grouping is count-bearing. */
  count?: number;
  threads: ThreadSummary[];
}

const STATUS_BUCKET: Record<ThreadStatus, "active" | "waiting" | "done"> = {
  running: "active",
  "awaiting-approval": "waiting",
  "awaiting-input": "waiting",
  idle: "done",
  interrupted: "done",
  error: "done",
};

const BUCKET_TITLES = { active: "进行中", waiting: "待处理", done: "已完成" } as const;

const DAY = 24 * 60 * 60 * 1000;

function dayBucket(iso: string, now: number): { key: string; title: string; order: number } {
  const delta = now - Date.parse(iso);
  if (delta < DAY) return { key: "today", title: "今天", order: 0 };
  if (delta < 2 * DAY) return { key: "yesterday", title: "昨天", order: 1 };
  if (delta < 7 * DAY) return { key: "week", title: "本周", order: 2 };
  return { key: "older", title: "更早", order: 3 };
}

/** The sidebar's three groupings. Threads always stay newest-first inside a group. */
export function groupThreads(
  threads: readonly ThreadSummary[],
  projects: readonly Project[],
  grouping: Grouping,
  now = Date.now(),
): ThreadGroup[] {
  const sorted = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (grouping === "project") {
    const byProject = new Map<string, ThreadSummary[]>();
    for (const thread of sorted) {
      const list = byProject.get(thread.projectId) ?? [];
      list.push(thread);
      byProject.set(thread.projectId, list);
    }
    return projects
      .filter((project) => byProject.has(project.id))
      .map((project) => ({ key: project.id, title: project.name, threads: byProject.get(project.id) ?? [] }))
      .concat(
        [...byProject.entries()]
          .filter(([id]) => !projects.some((project) => project.id === id))
          .map(([id, list]) => ({ key: id, title: "未知项目", threads: list })),
      );
  }

  if (grouping === "status") {
    const buckets: Array<keyof typeof BUCKET_TITLES> = ["active", "waiting", "done"];
    return buckets
      .map((bucket) => {
        const list = sorted.filter((thread) => STATUS_BUCKET[thread.status] === bucket);
        return { key: bucket, title: BUCKET_TITLES[bucket], count: list.length, threads: list };
      })
      .filter((group) => group.threads.length > 0);
  }

  const byDay = new Map<string, ThreadGroup & { order: number }>();
  for (const thread of sorted) {
    const bucket = dayBucket(thread.updatedAt, now);
    const group = byDay.get(bucket.key) ?? { key: bucket.key, title: bucket.title, order: bucket.order, threads: [] };
    group.threads.push(thread);
    byDay.set(bucket.key, group);
  }
  return [...byDay.values()].sort((a, b) => a.order - b.order);
}
