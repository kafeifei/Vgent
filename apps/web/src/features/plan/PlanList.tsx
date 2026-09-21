import { QueueItem, QueueItemContent, QueueItemIndicator } from "@/components/ai-elements/queue";
import { Spinner } from "@/features/worklog/ToolRow";
import { cn } from "@/lib/utils";
import type { PlanItem } from "./plan";

/**
 * The agent's todo list, wherever it is shown: under the plan call in the work
 * log and in the 计划 tab. AI Elements' queue item knows two states; the one
 * being worked on reads brighter, and spins only while the task is `live` — a
 * list in the log is a record of that moment, and nothing in it is running.
 */
export function PlanList({ items, live = false, className }: { items: readonly PlanItem[]; live?: boolean; className?: string }) {
  return (
    <ul className={className}>
      {items.map((item, index) => {
        const done = item.status === "done";
        return (
          <QueueItem key={index} className="px-2xs py-3xs hover:bg-transparent">
            <div className="flex items-center gap-xs">
              {item.status === "in_progress" && live ? <Spinner /> : <QueueItemIndicator completed={done} className="mt-0 flex-none" />}
              <QueueItemContent completed={done} className={cn(item.status === "in_progress" && "text-fg")}>
                {item.text}
              </QueueItemContent>
            </div>
          </QueueItem>
        );
      })}
    </ul>
  );
}
