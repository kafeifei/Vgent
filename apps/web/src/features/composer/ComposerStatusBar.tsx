import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { GitBranch } from "lucide-react";
import type { ChangedFile } from "@/lib/types";
import { ContextRing } from "./ContextRing";
import { sumChanges } from "./contextUsage";

/**
 * The row **under** the composer, in every task and in the empty state alike:
 * which branch, where it runs, what there is to review, how full the context is.
 *
 * It lives below the box rather than above it because it describes the task's
 * ground rather than the message being typed — 「在哪跑」 has to be readable
 * without opening anything, which is the whole point of moving it out of the
 * empty state. Above the box nothing is left but the queue and the notices.
 */
export function ComposerStatusBar({
  branch,
  branchTitle,
  location,
  changedFiles,
  onOpenChanges,
  messages,
  contextWindow,
}: {
  /** Absent (a detached HEAD, a project that is not a repo) hides the glyph too. */
  branch?: string | undefined;
  branchTitle?: string | undefined;
  /** 运行位置: the picker in the empty state, a static label once the task exists. */
  location: ReactNode;
  /** This task's changes, for the 审查 pill. Absent or empty = no pill. */
  changedFiles?: readonly ChangedFile[] | undefined;
  onOpenChanges?: (() => void) | undefined;
  /** This task's history, for the ring at the right end. Absent = no ring. */
  messages?: readonly UIMessage[] | undefined;
  contextWindow?: number | undefined;
}) {
  const sums = changedFiles == null ? null : sumChanges(changedFiles);

  return (
    <div className="flex min-h-review-bar items-center gap-2xs pt-2xs">
      {branch != null && (
        <span
          title={branchTitle ?? "当前分支"}
          className="inline-flex min-w-0 items-center gap-3xs px-2xs text-fg-muted text-xs"
        >
          <GitBranch className="size-md flex-none text-fg-faint" />
          <span className="min-w-0 truncate font-mono">{branch}</span>
        </span>
      )}
      {location}
      {sums != null && sums.files > 0 && (
        <button
          type="button"
          title={`${sums.files} 个文件有改动，点开右栏逐个看 diff`}
          onClick={onOpenChanges}
          className="inline-flex h-lg items-center gap-2xs rounded-full border border-border px-xs text-fg-muted text-xs hover:border-border-strong hover:text-fg"
        >
          <span>审查</span>
          <span className="font-mono text-diff-add-fg">+{sums.additions}</span>
          <span className="font-mono text-diff-del-fg">−{sums.deletions}</span>
        </button>
      )}
      {messages != null && <ContextRing messages={messages} {...(contextWindow != null ? { contextWindow } : {})} />}
    </div>
  );
}
