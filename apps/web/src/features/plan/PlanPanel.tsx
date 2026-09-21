import { useMemo } from "react";
import type { UIMessage } from "ai";
import { latestPlan } from "./plan";
import { PlanList } from "./PlanList";

/** 计划 tab: the agent's current todo list, from whichever engine last set one. */
export function PlanPanel({ messages, live }: { messages: UIMessage[]; live: boolean }) {
  const items = useMemo(() => latestPlan(messages), [messages]);

  if (items == null || items.length === 0) {
    return <p className="text-fg-faint text-xs">代理还没有制定计划</p>;
  }

  const done = items.filter((item) => item.status === "done").length;

  return (
    <>
      <div className="mb-xs text-fg-muted text-xs">
        {done} / {items.length} 完成
      </div>
      <PlanList items={items} live={live} />
    </>
  );
}
