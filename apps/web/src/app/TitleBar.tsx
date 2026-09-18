import { Folder } from "lucide-react";
import { ProjectPicker } from "@/components/ProjectPicker";
import type { Project } from "@/lib/types";

/**
 * The 36px window bar: brand + project switch on the left, the connection state
 * on the right. Nothing else — 新任务 and 搜索 are sidebar entries, 主题 and 密度
 * are an 外观 section in 设置, and 设置 itself is at the sidebar foot.
 */
export function TitleBar({
  projects,
  projectId,
  onSelectProject,
  onAddProject,
  onPickFolder,
  connected,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  connected: boolean;
}) {
  const project = projects.find((entry) => entry.id === projectId);

  return (
    <header className="flex select-none items-center gap-sm border-border border-b bg-bg-elevated px-sm">
      <span className="inline-flex items-center gap-xs font-semibold text-sm tracking-wide">
        <span className="grid size-lg flex-none place-items-center rounded-sm bg-brand font-bold font-mono text-brand-fg text-sm leading-none">
          V
        </span>
        Vgent
      </span>
      <span className="mx-3xs h-lg w-px bg-border" />

      <ProjectPicker
        projects={projects}
        selectedId={projectId}
        onSelect={onSelectProject}
        onAdd={onAddProject}
        onPickFolder={onPickFolder}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className="inline-flex items-center gap-xs rounded-sm px-xs py-3xs text-fg-muted text-sm hover:bg-bg-hover"
          >
            <Folder className="size-md" />
            <b className="max-w-[24ch] truncate font-semibold text-fg">{project?.name ?? "选择项目"}</b>
            <span className="opacity-60">▾</span>
          </button>
        )}
      />

      <span className="flex-1" />

      {!connected && <span className="text-danger text-xs">连接断开</span>}
    </header>
  );
}
