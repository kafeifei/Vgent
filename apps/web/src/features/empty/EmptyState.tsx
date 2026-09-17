import { useState } from "react";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Composer } from "@/features/composer/Composer";
import { useToast } from "@/lib/toast";
import type { Project } from "@/lib/types";

/**
 * 「配置 + 输入」, not 「欢迎语 + 建议」: pick the repo and the run location
 * first, then state the goal. Branch picking is deferred with worktrees.
 */
export function EmptyState({
  projects,
  projectId,
  onSelectProject,
  onAddProject,
  onStart,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onStart: (text: string) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const project = projects.find((entry) => entry.id === projectId);

  const submit = () => {
    if (draft.trim() === "") return;
    if (project == null) {
      toast("先选一个项目");
      return;
    }
    onStart(draft.trim());
    setDraft("");
  };

  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto_auto_auto_1fr] px-md">
      <div />
      <div className="mx-auto flex w-full max-w-log-max flex-col gap-sm">
        <div className="flex items-center gap-xs text-fg-muted text-sm">
          <span className="grid size-lg flex-none place-items-center rounded-sm bg-brand font-bold font-mono text-brand-fg text-sm leading-none">
            V
          </span>
          <span>Vgent · 描述一个目标，它在你选的运行位置里做完</span>
        </div>

        <div className="flex items-center gap-2xs">
          <ProjectPicker
            projects={projects}
            selectedId={projectId}
            onSelect={onSelectProject}
            onAdd={onAddProject}
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
              >
                <span>{project?.name ?? "选择仓库"}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          />
          <span className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-sm">
            <span>本机</span>
          </span>
        </div>
      </div>

      <div className="mx-auto w-full max-w-log-max py-sm">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          live={false}
          model={undefined}
          onPickModel={() => toast("新任务用默认模型，创建后可改")}
          autoFocus
          big
        />
      </div>

      <div className="mx-auto flex w-full max-w-log-max flex-wrap gap-xs">
        <button
          type="button"
          onClick={() => toast("下一步")}
          className="inline-flex h-xl items-center gap-xs rounded-full border border-border bg-bg-elevated px-md text-fg-muted text-sm hover:border-border-strong hover:text-fg"
        >
          规划一个想法
          <span className="font-mono text-fg-faint text-xs">⇧Tab</span>
        </button>
        <button
          type="button"
          onClick={() => toast("下一步")}
          className="inline-flex h-xl items-center rounded-full border border-border bg-bg-elevated px-md text-fg-muted text-sm hover:border-border-strong hover:text-fg"
        >
          打开编辑器
        </button>
      </div>
      <div />
    </div>
  );
}
