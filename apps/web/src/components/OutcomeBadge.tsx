import type { ThreadOutcome } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 收口态 in one line: 「已提交 a1b2c3d」/ PR（链接）/「已带回主目录」/「已丢弃」.
 * Shown in the task header, the sidebar row and the 变更 panel's action bar.
 */
export function OutcomeBadge({ outcome, className }: { outcome: ThreadOutcome; className?: string }) {
  if (outcome.kind === "pr" && outcome.url != null) {
    return (
      <a
        href={outcome.url}
        target="_blank"
        rel="noreferrer"
        title={outcome.url}
        onClick={(event) => event.stopPropagation()}
        className={cn("flex-none truncate text-brand text-xs underline-offset-2 hover:underline", className)}
      >
        PR
      </a>
    );
  }
  const text =
    outcome.kind === "committed"
      ? `已提交 ${outcome.ref?.slice(0, 7) ?? ""}`.trim()
      : outcome.kind === "pr"
        ? "已开 PR"
        : outcome.kind === "applied"
          ? "已带回主目录"
          : "已丢弃";
  return <span className={cn("flex-none truncate text-fg-faint text-xs", className)}>{text}</span>;
}
