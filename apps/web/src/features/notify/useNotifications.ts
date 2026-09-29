import { useEffect, useRef } from "react";
import type { ThreadStatus, ThreadSummary } from "@/lib/types";
import { onNotificationOpen, sendSystemNotification } from "./host";
import { decideNotification } from "./notify";

/** The gate is `document.hidden || !document.hasFocus()`; this is its positive form. */
const windowFocused = (): boolean => typeof document !== "undefined" && !document.hidden && document.hasFocus();

/**
 * 「任务跑完或需要你了，叫你一声」.
 *
 * The ledger is the status each task was last seen in, kept for as long as the
 * workbench is mounted. It is what turns a stream of identical snapshots into
 * one notification per transition: every pass writes the current status back,
 * so re-renders and reconnects find nothing new to announce.
 */
export function useNotifications(options: {
  threads: readonly ThreadSummary[];
  /** 设置里的「系统通知」. */
  enabled: boolean;
  onSelect: (threadId: string) => void;
  /** What 等你审批 is about, when this window has the task's chat loaded. */
  detailOf: (threadId: string) => string | undefined;
}): void {
  const { threads, enabled, onSelect, detailOf } = options;
  const seen = useRef<Map<string, ThreadStatus>>(new Map());
  const latest = useRef(threads);
  latest.current = threads;

  // A click on a task deleted since it was announced just leaves the window up.
  useEffect(() => onNotificationOpen((threadId) => {
    if (latest.current.some((thread) => thread.id === threadId)) onSelect(threadId);
  }), [onSelect]);

  useEffect(() => {
    const ledger = seen.current;
    const focused = windowFocused();
    for (const thread of threads) {
      const previous = ledger.get(thread.id);
      ledger.set(thread.id, thread.status);
      const decision = decideNotification({ thread, previous, enabled, focused, detail: detailOf(thread.id) });
      if (decision == null) continue;
      void sendSystemNotification(decision);
    }
    for (const id of [...ledger.keys()]) {
      if (!threads.some((thread) => thread.id === id)) ledger.delete(id);
    }
  }, [detailOf, enabled, threads]);
}
