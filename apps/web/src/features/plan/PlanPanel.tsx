import { useMemo } from "react";
import type { UIMessage } from "ai";
import { Check, Circle } from "lucide-react";
import { Spinner } from "@/features/worklog/ToolRow";
import { cn } from "@/lib/utils";
import { latestPlan, type PlanItem } from "./plan";

function StatusIcon({ status }: { status: PlanItem["status"] }) {
  if (status === "in_progress") return <Spinner />;
  if (status === "done") {
    return (
      <span className="grid size-md flex-none place-items-center rounded-full bg-success-bg text-success">
        <Check className="size-2xs" />
      </span>
    );
  }
  return <Circle className="size-md flex-none text-fg-faint" />;
}

/** 计划 tab: the agent's current todo list, from whichever engine last set one. */
export function PlanPanel({ messages }: { messages: UIMessage[] }) {
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
      {items.map((item, index) => (
        <div key={index} className="flex items-center gap-xs px-2xs py-3xs text-sm">
          <StatusIcon status={item.status} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              item.status === "done" ? "text-fg-faint line-through" : "text-fg",
            )}
          >
            {item.text}
          </span>
        </div>
      ))}
    </>
  );
}
