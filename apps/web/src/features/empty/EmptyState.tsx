import { useState } from "react";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Composer } from "@/features/composer/Composer";
import { ENGINES, PERMISSIONS } from "@/lib/engineOptions";
import { useToast } from "@/lib/toast";
import type { EngineId, PermissionMode, Project, Settings, WorkspaceMode } from "@/lib/types";

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
 * 「配置 + 输入」, not 「欢迎语 + 建议」: pick the repo and the run location
 * first, then state the goal. Branch picking is deferred with worktrees.
 */
export function EmptyState({
  projects,
  projectId,
  settings,
  onSelectProject,
  onAddProject,
  onPickFolder,
  onStart,
}: {
  projects: Project[];
  projectId: string | null;
  settings: Settings | null;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  onStart: (
    text: string,
    engine: EngineId,
    workspace: WorkspaceMode,
    model: string | null,
    permissionMode: PermissionMode,
    reasoningEffort: string | null,
  ) => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  // Local only, no persistence: seeded from the server default once, not kept
  // in sync if the setting changes later while this screen is open.
  const [engine, setEngine] = useState<EngineId>(() => settings?.defaultEngine ?? "claude-code");
  // `null` means「用默认」: the server picks `settings.defaultModel`. Reset when
  // the engine changes, since a model id only means something to one engine.
  const [model, setModel] = useState<string | null>(null);
  // Same story: a level belongs to a model, so switching either one clears it
  // and the model's own default applies again.
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    () => settings?.defaultPermissionMode ?? "allow-reads",
  );
  const [workspace, setWorkspace] = useState<WorkspaceMode>("project");
  const project = projects.find((entry) => entry.id === projectId);
  // Codex has no built-in tool approval, so the server refuses any other mode.
  const effectivePermission: PermissionMode = engine === "codex" ? "allow-all" : permissionMode;

  const submit = () => {
    if (draft.trim() === "") return;
    if (project == null) {
      toast("先选一个项目");
      return;
    }
    onStart(draft.trim(), engine, workspace, model, effectivePermission, reasoningEffort);
    setDraft("");
  };

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
          <Popover
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
              >
                <span>{ENGINES.find((entry) => entry.id === engine)?.label ?? engine}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <PopTitle>引擎</PopTitle>
                {ENGINES.map((entry) => (
                  <PopItem
                    key={entry.id}
                    selected={entry.id === engine}
                    onClick={() => {
                      setEngine(entry.id);
                      setModel(null);
                      setReasoningEffort(null);
                      close();
                    }}
                  >
                    {entry.label}
                  </PopItem>
                ))}
              </>
            )}
          </Popover>
          {/* The same choice `TaskHeader` offers, made before the task exists. */}
          <Popover
            trigger={(props) => (
              <button
                type="button"
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
              >
                <span className="font-mono">{effectivePermission}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <PopTitle>权限模式</PopTitle>
                {PERMISSIONS.map((mode) => {
                  const codexLocked = engine === "codex" && mode !== "allow-all";
                  return (
                    <PopItem
                      key={mode}
                      selected={mode === effectivePermission}
                      disabled={codexLocked}
                      {...(codexLocked ? { hint: "Codex 只支持 allow-all" } : {})}
                      onClick={() => {
                        setPermissionMode(mode);
                        close();
                      }}
                    >
                      <span className="font-mono">{mode}</span>
                    </PopItem>
                  );
                })}
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
          engine={engine}
          model={model ?? undefined}
          defaultModel={settings?.defaultModel}
          onPickModel={(next) => {
            setModel(next);
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
