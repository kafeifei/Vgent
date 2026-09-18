import type { ThreadOutcome, ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

/** `已提交 a1b2c3d`, and what the other three kinds read as. */
function outcomeText(outcome: ThreadOutcome): string {
  if (outcome.kind === "committed") return `已提交 ${outcome.ref?.slice(0, 7) ?? ""}`.trim();
  if (outcome.kind === "pr") return "已开 PR";
  if (outcome.kind === "pushed") return `已推送 ${outcome.ref ?? ""}`.trim();
  if (outcome.kind === "applied") return "已带回主目录";
  return "已丢弃";
}

/** The link itself: a real pull request, or the compare page that is one click short of one. */
function PrLink({ pr, className }: { pr: ThreadPullRequest; className?: string | undefined }) {
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={pr.url}
      onClick={(event) => event.stopPropagation()}
      className={cn("flex-none truncate text-brand text-xs underline-offset-2 hover:underline", className)}
    >
      {pr.kind === "compare" ? "去开 PR" : `PR${pr.number != null ? ` #${pr.number}` : ""}`}
    </a>
  );
}

/**
 * 收口态 in one line: 「已提交 a1b2c3d」/ PR（链接）/「已带回主目录」/「已丢弃」.
 * Shown in the task header, the sidebar row and the 变更 panel's action bar.
 *
 * `pr` is the task's PR link, which outlives `outcome` — a new turn clears the
 * 收口态, but the pull request it opened is still there. When both are present
 * and both are about that PR, only the link is shown: two badges saying the same
 * thing would just be noise.
 */
export function OutcomeBadge({
  outcome,
  pr,
  className,
}: {
  outcome?: ThreadOutcome | undefined;
  pr?: ThreadPullRequest | undefined;
  className?: string;
}) {
  if (pr != null) {
    // An outcome that is *not* about the PR still has something to say.
    const extra = outcome != null && outcome.kind !== "pr" ? outcomeText(outcome) : null;
    return (
      <span className={cn("flex min-w-0 flex-none items-center gap-2xs", className)}>
        {extra != null && <span className="truncate text-fg-faint text-xs">{extra}</span>}
        <PrLink pr={pr} />
      </span>
    );
  }
  if (outcome == null) return null;
  // A task from before the PR link was stored on its own still carries the URL here.
  if (outcome.kind === "pr" && outcome.url != null) {
    return <PrLink pr={{ url: outcome.url, kind: "pr", at: outcome.at }} className={className} />;
  }
  return <span className={cn("flex-none truncate text-fg-faint text-xs", className)}>{outcomeText(outcome)}</span>;
}
