import { Archive } from "lucide-react";

/**
 * What stands where the composer was once a task is archived. 归档 means the
 * task is put away — the server refuses a new turn on it — so there is nothing
 * to type into; the one way on is to take it back out.
 */
export function ArchivedBar({ onUnarchive }: { onUnarchive: () => void }) {
  return (
    <div className="mx-auto w-full max-w-log-max">
      <div className="flex items-center gap-xs rounded-2xl border border-border bg-bg-elevated py-1.25 pr-1.25 pl-md text-fg-muted text-sm shadow-xs">
        <Archive className="size-md flex-none text-fg-faint" />
        <span className="min-w-0 flex-1 truncate">已归档</span>
        <button
          type="button"
          onClick={onUnarchive}
          className="inline-flex h-7 flex-none items-center rounded-full border border-border px-sm text-fg hover:border-border-strong hover:bg-bg-hover"
        >
          取消归档
        </button>
      </div>
      {/* The composer's status row sits here; keeping its height keeps the log from jumping on 取消归档. */}
      <div className="mt-1.25 min-h-review-bar" />
    </div>
  );
}
