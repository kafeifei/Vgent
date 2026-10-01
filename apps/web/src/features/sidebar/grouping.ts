import { useMemo, useSyncExternalStore } from "react";
import { NO_PROJECT_NAME, isNoProject } from "@/lib/noProject";
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
  /** A workspace row can start a task even when it has no tasks yet. */
  projectId?: string;
  /** Shown after the title when the grouping is count-bearing. */
  count?: number;
  /** 已归档 comes in folded; every other group is always open. */
  collapsible?: boolean;
  threads: ThreadSummary[];
}

export const ARCHIVED_KEY = "archived";

type StatusBucket = "active" | "waiting" | "review" | "done";

const STATUS_BUCKET: Record<ThreadStatus, Exclude<StatusBucket, "review">> = {
  running: "active",
  "awaiting-approval": "waiting",
  "awaiting-input": "waiting",
  idle: "done",
  interrupted: "waiting",
  error: "waiting",
};

const BUCKET_TITLES: Record<StatusBucket, string> = {
  active: "进行中",
  waiting: "待处理",
  review: "待验收",
  done: "已完成",
};

export const isArchived = (thread: ThreadSummary): boolean => thread.archivedAt != null;

/**
 * 待验收: the task is not running, it left changes behind, and nobody has
 * decided what to do with them yet. This is the group the user most needs.
 */
export function needsReview(thread: ThreadSummary): boolean {
  return thread.status === "idle" && (thread.changeStats?.files ?? 0) > 0 && thread.outcome == null && !isArchived(thread);
}

/**
 * 待验收 wins as before — it is the group the user most needs. Otherwise a task
 * that finished while nobody was looking waits in 待处理 instead of dropping
 * silently into 已完成; reading it moves it on.
 */
const bucketOf = (thread: ThreadSummary): StatusBucket => {
  if (needsReview(thread)) return "review";
  const bucket = STATUS_BUCKET[thread.status];
  return bucket === "done" && thread.unread === true ? "waiting" : bucket;
};

const DAY = 24 * 60 * 60 * 1000;

function dayBucket(iso: string, now: number): { key: string; title: string; order: number } {
  const delta = now - Date.parse(iso);
  if (delta < DAY) return { key: "today", title: "今天", order: 0 };
  if (delta < 2 * DAY) return { key: "yesterday", title: "昨天", order: 1 };
  if (delta < 7 * DAY) return { key: "week", title: "本周", order: 2 };
  return { key: "older", title: "更早", order: 3 };
}

/**
 * The sidebar's three groupings. Threads stay newest-first inside a group, and
 * archived ones are pulled out of whichever group they would have landed in and
 * collected at the bottom — the same place in all three.
 */
export function groupThreads(
  threads: readonly ThreadSummary[],
  projects: readonly Project[],
  grouping: Grouping,
  now = Date.now(),
): ThreadGroup[] {
  const ordered = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const archived = ordered.filter(isArchived);
  const sorted = ordered.filter((thread) => !isArchived(thread));
  const withArchived = (groups: ThreadGroup[]): ThreadGroup[] =>
    archived.length === 0
      ? groups
      : [...groups, { key: ARCHIVED_KEY, title: "已归档", count: archived.length, collapsible: true, threads: archived }];

  if (grouping === "project") {
    const byProject = new Map<string, ThreadSummary[]>();
    for (const thread of sorted) {
      const list = byProject.get(thread.projectId) ?? [];
      list.push(thread);
      byProject.set(thread.projectId, list);
    }
    return withArchived(
      projects
        .map((project): ThreadGroup => ({ key: project.id, projectId: project.id, title: project.name, threads: byProject.get(project.id) ?? [] }))
        .concat(
          [...byProject.entries()]
            .filter(([id]) => !projects.some((project) => project.id === id))
            .map(([id, list]) => ({ key: id, ...(isNoProject(id) ? { projectId: id } : {}), title: isNoProject(id) ? NO_PROJECT_NAME : "未知项目", threads: list })),
        ),
    );
  }

  if (grouping === "status") {
    const buckets: StatusBucket[] = ["active", "waiting", "review", "done"];
    return withArchived(
      buckets
        .map((bucket) => {
          const list = sorted.filter((thread) => bucketOf(thread) === bucket);
          return { key: bucket, title: BUCKET_TITLES[bucket], count: list.length, threads: list };
        })
        .filter((group) => group.threads.length > 0),
    );
  }

  const byDay = new Map<string, ThreadGroup & { order: number }>();
  for (const thread of sorted) {
    const bucket = dayBucket(thread.updatedAt, now);
    const group = byDay.get(bucket.key) ?? { key: bucket.key, title: bucket.title, order: bucket.order, threads: [] };
    group.threads.push(thread);
    byDay.set(bucket.key, group);
  }
  return withArchived([...byDay.values()].sort((a, b) => a.order - b.order));
}

const currentMinute = (): number => Math.floor(Date.now() / 60_000);

const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setTimeout> | undefined;

function armMinute(): void {
  minuteTimer = setTimeout(() => {
    for (const listener of [...minuteListeners]) listener();
    armMinute();
  }, 60_000 - (Date.now() % 60_000) + 50);
}

/**
 * Ticks on the clock's own minute boundaries, so a window left open and idle
 * still turns 今天 into 昨天 on time. One timer for every subscriber: each row's
 * stamp listens too, and they all move in the same render.
 */
function subscribeMinute(notify: () => void): () => void {
  minuteListeners.add(notify);
  if (minuteListeners.size === 1) armMinute();
  return () => {
    minuteListeners.delete(notify);
    if (minuteListeners.size > 0) return;
    clearTimeout(minuteTimer);
    minuteTimer = undefined;
  };
}

/** The current minute (since the epoch), rendering again when the clock moves to the next. */
export function useMinute(): number {
  return useSyncExternalStore(subscribeMinute, currentMinute, currentMinute);
}

/**
 * `groupThreads` for a component that renders far more often than its tasks
 * change (a task streaming re-renders everything above it): grouped again only
 * when the tasks, the projects or the way of grouping are different objects —
 * or the clock moved to another minute, since the day groups ("今天" / "昨天")
 * are cut against it, which it hears of itself: an idle window has nothing else
 * that would render it again. Anything else hands back the very same groups.
 */
export function useGroupedThreads(threads: readonly ThreadSummary[], projects: readonly Project[], grouping: Grouping): ThreadGroup[] {
  const minute = useMinute();
  return useMemo(() => groupThreads(threads, projects, grouping, minute * 60_000), [threads, projects, grouping, minute]);
}
