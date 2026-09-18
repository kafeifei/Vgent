import type { WorkspaceSetup } from "@/lib/types";

/**
 * One line above the work log while the project's setup script runs in a fresh
 * worktree, and one warning when it failed — the task still runs, it just may
 * not have its dependencies. Nothing at all when setup went fine, or when the
 * project has no setup config.
 */
export function SetupNotice({ setup, onOpenLog }: { setup: WorkspaceSetup | undefined; onOpenLog: () => void }) {
  if (setup == null || setup.status === "ok") return null;

  if (setup.status === "running") {
    return (
      <div className="border-border border-b bg-bg px-md py-2xs text-fg-muted text-xs">
        正在准备工作目录…
      </div>
    );
  }

  return (
    <div className="flex items-center gap-xs border-border border-b bg-warning-bg px-md py-2xs text-warning text-xs">
      <span>工作目录准备失败{setup.exitCode != null ? `（退出码 ${setup.exitCode}）` : ""}，任务仍可运行</span>
      <button type="button" onClick={onOpenLog} className="underline underline-offset-2 hover:no-underline">
        查看日志
      </button>
    </div>
  );
}
