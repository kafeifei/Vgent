import type { ReactNode } from "react";

/**
 * What stands where the composer was when the task cannot take a message: the
 * composer's shell, saying why in place of the text. Cursor locks its input the
 * same way — read-only, its placeholder reading 「Worktree setup failed」.
 */
export function LockedBar({ label, icon, children }: { label: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-log-max">
      <div className="flex items-center gap-xs rounded-2xl border border-border bg-bg-elevated py-1.25 pr-1.25 pl-md text-fg-muted text-sm shadow-xs">
        {icon}
        <span className="flex h-7 min-w-0 flex-1 items-center truncate">{label}</span>
        {children}
      </div>
      {/* The composer's status row sits here; keeping its height keeps the log from jumping. */}
      <div className="mt-1.25 min-h-review-bar" />
    </div>
  );
}
