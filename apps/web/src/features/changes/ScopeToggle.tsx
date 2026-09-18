import type { ChangesScope } from "@/lib/types";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ChangesScope; label: string; title: string }[] = [
  { value: "all", label: "全部改动", title: "任务从开跑到现在改的全部内容，对着任务基线" },
  { value: "last-turn", label: "上一轮", title: "最后一轮开跑前和结束后两个快照之间的差别，只看不改" },
];

/**
 * 改动的范围, at the top of the 变更 panel. Two values and no more: the task as
 * a whole, and what its last turn did. Only rendered when the task really has a
 * last turn to show — the panel decides that from the server's answer, not from
 * the shape of the thread.
 */
export function ScopeToggle({ scope, onScope }: { scope: ChangesScope; onScope: (scope: ChangesScope) => void }) {
  return (
    <div className="mb-xs inline-flex rounded-sm border border-border p-3xs" role="group" aria-label="改动范围">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={scope === option.value}
          onClick={() => onScope(option.value)}
          className={cn(
            "inline-flex h-xl items-center rounded-sm px-xs text-xs",
            scope === option.value ? "bg-bg-active text-fg" : "text-fg-faint hover:bg-bg-hover hover:text-fg-muted",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
