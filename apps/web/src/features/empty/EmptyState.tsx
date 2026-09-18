import { useState } from "react";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Composer } from "@/features/composer/Composer";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, Project, Settings, WorkspaceMode } from "@/lib/types";

/**
 * The two run locations, with the sentence that tells them apart. 「独立检出」
 * is spelled out because the surprise it avoids — a worktree starts from the
 * *committed* HEAD, without your uncommitted work — is otherwise only
 * discovered afterwards.
 */
const WORKSPACES: ReadonlyArray<{ id: WorkspaceMode; label: string; hint: string }> = [
  { id: "project", label: "本机 · 主目录", hint: "直接改你手上的文件，收口时只能提交或丢弃" },
  {
    id: "worktree",
    label: "本机 · worktree",
    hint: "独立检出，从已提交的 HEAD 开出，不带你未提交的改动；完成后可提交、开 PR 或带回主目录",
  },
];

/**
 * 「配置 + 输入」, not 「欢迎语 + 建议」. Four choices and no more: 项目 and
 * 运行位置 on this row, 模型 and 思考等级 inside the composer. 运行模式 is a
 * global setting now, so there is no permission control here at all.
 */
export function EmptyState({
  projects,
  projectId,
  engines,
  settings,
  onSelectProject,
  onAddProject,
  onPickFolder,
  onStart,
}: {
  projects: Project[];
  projectId: string | null;
  engines: EngineDescriptor[];
  settings: Settings | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  onStart: (
    text: string,
    engine: EngineId,
    workspace: WorkspaceMode,
    model: string | null,
    reasoningEffort: string | null,
  ) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  /**
   * The model this task will run on, and the engine that comes with it. Null
   * until the user picks one, so until then the settings answer — and keep
   * answering if they change while this screen is open.
   */
  const [picked, setPicked] = useState<{ engine: EngineId; model: string | null } | null>(null);
  // A level belongs to a model, so switching the model clears it and the
  // model's own default applies again.
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceMode>("project");
  const project = projects.find((entry) => entry.id === projectId);

  const engine = picked?.engine ?? settings?.defaultEngine ?? engines[0]?.id;
  // `null` means「用默认」: the server falls back to `settings.defaultModel`.
  const model = picked?.model ?? (picked == null ? (settings?.defaultModel ?? null) : null);

  const submit = () => {
    if (engine == null) return;
    if (draft.trim() === "") return;
    if (project == null) {
      toast("先选一个项目");
      return;
    }
    onStart(draft.trim(), engine, workspace, model, reasoningEffort);
    setDraft("");
  };

  // The engine list and the settings arrive in the same round trip; without
  // them there is no honest model to show.
  if (engine == null) return <div className="grid h-full place-items-center text-fg-faint text-sm">加载中…</div>;

  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto_auto_1fr] px-md">
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
            onPickFolder={onPickFolder}
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
          {/* 运行位置：一个选择器，两个值。它决定这个任务改谁的文件。 */}
          <Popover
            className="max-w-[calc(var(--spacing-3xl)*8)]"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
              >
                <span>{WORKSPACES.find((entry) => entry.id === workspace)?.label}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <PopTitle>运行位置</PopTitle>
                {WORKSPACES.map((entry) => (
                  <PopItem
                    key={entry.id}
                    selected={entry.id === workspace}
                    onClick={() => {
                      setWorkspace(entry.id);
                      close();
                    }}
                  >
                    <span className="flex flex-col gap-3xs whitespace-normal">
                      <span className="text-fg">{entry.label}</span>
                      <span className="text-fg-faint text-xs leading-snug">{entry.hint}</span>
                    </span>
                  </PopItem>
                ))}
              </>
            )}
          </Popover>
        </div>
      </div>

      <div className="mx-auto w-full max-w-log-max py-sm">
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          live={false}
          engines={engines}
          engine={engine}
          model={model ?? undefined}
          defaultModel={settings?.defaultModel}
          runMode={settings?.runMode}
          onPickModel={(nextEngine, nextModel) => {
            setPicked({ engine: nextEngine, model: nextModel ?? null });
            setReasoningEffort(null);
          }}
          reasoningEffort={reasoningEffort ?? undefined}
          onPickReasoning={setReasoningEffort}
          location={workspace === "worktree" ? "worktree" : "主目录"}
          autoFocus
          big
        />
      </div>

      <div />
    </div>
  );
}
