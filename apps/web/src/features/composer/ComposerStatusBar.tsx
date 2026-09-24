import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { GitBranch } from "lucide-react";
import type { ChangedFile } from "@/lib/types";
import { ContextRing } from "./ContextRing";
import { sumChanges } from "./contextUsage";

/**
 * The row **under** the composer in every task: which branch, where it runs,
 * what there is to review, how full the context is.
 *
 * It lives below the box rather than above it because it describes the task's
 * ground rather than the message being typed. The empty state has no such row:
 * its branch and 运行位置 sit next to the project picker above the box.
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
  /** 运行位置, a static label once the task exists. */
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
    <div className="mt-1.25 flex min-h-review-bar items-center gap-xs px-chat-inset text-fg-muted text-sm">
      {branch != null && (
        <span
          title={branchTitle ?? "当前分支"}
          className="inline-flex min-w-0 items-center gap-2xs"
        >
          <GitBranch className="size-md flex-none text-fg-faint" />
          <span className="min-w-0 truncate">{branch}</span>
        </span>
      )}
      {location}
      {sums != null && sums.files > 0 && (
        <button
          type="button"
          title={`${sums.files} 个文件有改动，点开右栏逐个看 diff`}
          onClick={onOpenChanges}
          className="inline-flex h-xl items-center gap-2xs rounded-full border border-border px-sm text-fg-muted text-sm hover:border-border-strong hover:text-fg"
        >
          <span>审查</span>
          <span className="font-mono text-diff-add-fg">+{sums.additions}</span>
          <span className="font-mono text-diff-del-fg">−{sums.deletions}</span>
        </button>
      )}
      <span className="flex-1" />
      {messages != null && <ContextRing messages={messages} {...(contextWindow != null ? { contextWindow } : {})} />}
    </div>
  );
}
