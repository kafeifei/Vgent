import { AlignJustify, Folder, Moon, Sun } from "lucide-react";
import { ProjectPicker } from "@/components/ProjectPicker";
import { usePrefs } from "@/lib/prefs";
import type { Project } from "@/lib/types";

/**
 * The 36px window bar: brand + project switch on the left, the two global
 * toggles and ⌘K on the right. Settings live at the sidebar foot, not here.
 */
export function TitleBar({
  projects,
  projectId,
  onSelectProject,
  onAddProject,
  onPickFolder,
  onOpenPalette,
  connected,
}: {
  projects: Project[];
  projectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  onOpenPalette: () => void;
  connected: boolean;
}) {
  const { theme, density, toggleTheme, toggleDensity } = usePrefs();
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

      <button
        type="button"
        title="密度（舒适 / 紧凑）"
        onClick={toggleDensity}
        className="inline-flex h-xl items-center gap-2xs rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
      >
        <AlignJustify className="size-md" />
        {density === "compact" ? "紧凑" : "舒适"}
      </button>
      <button
        type="button"
        title="主题"
        onClick={toggleTheme}
        className="inline-flex h-xl items-center gap-2xs rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
      >
        {theme === "light" ? <Sun className="size-md" /> : <Moon className="size-md" />}
        {theme === "light" ? "浅色" : "深色"}
      </button>
      <button
        type="button"
        onClick={onOpenPalette}
        className="inline-flex h-xl items-center rounded-sm px-xs font-mono text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
      >
        ⌘K
      </button>
    </header>
  );
}
