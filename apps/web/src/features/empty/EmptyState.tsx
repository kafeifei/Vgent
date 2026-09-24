import { useEffect, useRef, useState } from "react";
import { ChevronDown, GitBranch } from "lucide-react";
import type { Attachment } from "@/features/composer/attachments";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Composer } from "@/features/composer/Composer";
import type { ApiClient } from "@/lib/api";
import type { DraftTransport } from "@/lib/drafts";
import { NEW_TASK_DRAFT, useDraft } from "@/lib/drafts";
import { useToast } from "@/lib/toast";
import { NO_PROJECT_NAME, isNoProject } from "@/lib/noProject";
import type { NewTaskSeed } from "@/app/useWorkbench";
import type { EngineDescriptor, EngineId, Project, Settings, ThreadMode, WorkspaceMode } from "@/lib/types";

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
 * 「配置 + 输入」, not 「欢迎语 + 建议」. One row above the composer — 项目, its
 * branch, 运行位置 — and 模型 and 思考等级 inside it; nothing under it. 运行模式
 * is a global setting now, so there is no permission control here at all.
 */
export function EmptyState({
  projects,
  projectId,
  engines,
  settings,
  seed,
  client,
  onSelectProject,
  onAddProject,
  onPickFolder,
  onStart,
  onRememberEngine,
}: {
  projects: Project[];
  projectId: string | null;
  engines: EngineDescriptor[];
  settings: Settings | null;
  /**
   * The task 新任务 was pressed on top of, if any: its engine and model are
   * the 临时默认值 here, ahead of the last started choice the server keeps.
   */
  seed: NewTaskSeed | null;
  /**
   * The draft routes — this screen's draft lives on the server like every
   * other — plus the project's current branch, for the row above the composer.
   */
  client: DraftTransport & Pick<ApiClient, "getProjectBranch">;
  onSelectProject: (projectId: string) => void;
  onAddProject: (repoPath: string) => Promise<void>;
  onPickFolder: () => Promise<string | null>;
  /** Resolves `false` when the task could not be created, which keeps the draft. */
  onStart: (
    text: string,
    engine: EngineId,
    workspace: WorkspaceMode,
    model: string | null,
    reasoningEffort: string | null,
    mode: ThreadMode,
    attachments: readonly Attachment[],
    serviceTier: string | null,
    contextWindow: number | null,
  ) => Promise<boolean>;
  onRememberEngine: (modelKey: string, engine: EngineId) => void;
}) {
  const toast = useToast();
  // 草稿不丢, here too: the empty state has no task yet, so its draft is kept
  // under a fixed key until it becomes a task's first message.
  const draft = useDraft(NEW_TASK_DRAFT, client);
  /**
   * The model this task will run on, and the engine that comes with it. Null
   * until the user picks one, so until then the settings answer — and keep
   * answering if they change while this screen is open.
   */
  const [picked, setPicked] = useState<{ engine: EngineId; model: string | null } | null>(null);
  // A level belongs to a model, so switching the model clears it and the
  // model's own default applies again.
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [serviceTier, setServiceTier] = useState<string | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceMode>("project");
  /** 模式 rides on the creation request; there is no task to PATCH yet. */
  const [mode, setMode] = useState<ThreadMode>("agent");
  const project = projects.find((entry) => entry.id === projectId);
  const noProject = isNoProject(projectId);

  /**
   * The branch the row above the composer names: whichever one this checkout is
   * on, because that is both where a 主目录 task would write and what a worktree
   * task would be cut from. Fetched per project; a repo we cannot read simply
   * has no branch to show.
   */
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    setBranch(null);
    // 无项目 has no repository, so no branch either.
    if (projectId == null || isNoProject(projectId)) return;
    let cancelled = false;
    void client.getProjectBranch(projectId).then(
      (result) => {
        if (!cancelled) setBranch(result.branch);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);

  const engine = picked?.engine ?? seed?.engine ?? settings?.defaultEngine ?? engines[0]?.id;
  // `null` means「用默认」: the server falls back to `settings.defaultModel`.
  const model = picked?.model ?? (picked == null ? ((seed != null ? seed.model : settings?.defaultModel) ?? null) : null);

  /** One in-flight start at a time: the text stays until the task really exists. */
  const starting = useRef(false);
  // 附件 are part of the draft too: a file dropped here is on the server under
  // `new` until it becomes the first message's, or the tile is removed.
  const { attachments, setAttachments } = draft;
  const submit = () => {
    if (engine == null || starting.current) return;
    const text = draft.value.trim();
    if (text === "" && attachments.length === 0) return;
    if (project == null && !noProject) {
      toast("先选一个项目");
      return;
    }
    starting.current = true;
    // A worktree is cut from a repository; 无项目 has none.
    void onStart(text, engine, noProject ? "project" : workspace, model, reasoningEffort, mode, attachments, serviceTier, contextWindow).then((started) => {
      starting.current = false;
      if (started) draft.clear();
    });
  };

  // The engine list and the settings arrive in the same round trip; without
  // them there is no honest model to show.
  if (engine == null) return <div className="grid h-full place-items-center text-fg-faint text-sm">加载中…</div>;

  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto_auto_1fr] px-md">
      <div />
      <div className="mx-auto flex w-full max-w-log-max items-center gap-2xs text-fg-muted text-sm">
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
              className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs hover:bg-bg-hover hover:text-fg"
            >
              <span>{noProject ? NO_PROJECT_NAME : (project?.name ?? "选择仓库")}</span>
              <ChevronDown className="size-sm flex-none text-fg-faint" />
            </button>
          )}
        />
        {branch != null && (
          <span
            title={workspace === "worktree" ? "新任务从这个分支已提交的 HEAD 开出独立检出" : "新任务直接改这个检出里的文件"}
            className="inline-flex min-w-0 items-center gap-2xs px-xs"
          >
            <GitBranch className="size-md flex-none text-fg-faint" />
            <span className="min-w-0 truncate">{branch}</span>
          </span>
        )}
        {/* 运行位置：一个选择器，两个值，决定这个任务改谁的文件。只有这里能改，任务建出来就定了。 */}
        {noProject ? (
          <span title="这个任务不属于任何项目：它在自己的临时目录里跑，任务删掉目录也删掉" className="px-xs">
            临时目录
          </span>
        ) : (
          <Popover
            className="max-w-[calc(var(--spacing-3xl)*8)]"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                title="这个任务在哪里改文件"
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs hover:bg-bg-hover hover:text-fg"
              >
                <span>{WORKSPACES.find((entry) => entry.id === workspace)?.label}</span>
                <ChevronDown className="size-sm flex-none text-fg-faint" />
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
        )}
      </div>

      <div className="mx-auto w-full max-w-log-max py-sm">
        <Composer
          value={draft.value}
          onChange={draft.edit}
          attachments={attachments}
          onAttachments={setAttachments}
          onSubmit={submit}
          live={false}
          engines={engines}
          engine={engine}
          model={model ?? undefined}
          runMode={settings?.runMode}
          modelEngines={settings?.modelEngines}
          onRememberEngine={onRememberEngine}
          onPickModel={(nextEngine, nextModel) => {
            // Settling「没选模型」onto a concrete one is not a change of model:
            // a 推理强度 the user already set stays. Switching away does reset
            // both, because a window and an effort belong to the model they
            // were picked for.
            const previous = picked?.model ?? (picked == null ? (settings?.defaultModel ?? null) : null);
            setPicked({ engine: nextEngine, model: nextModel ?? null });
            if (previous != null && (previous !== nextModel || picked?.engine !== nextEngine)) {
              setReasoningEffort(null);
              setContextWindow(null);
            }
          }}
          contextWindow={contextWindow ?? undefined}
          onPickContext={setContextWindow}
          reasoningEffort={reasoningEffort ?? undefined}
          serviceTier={serviceTier ?? undefined}
          onPickServiceTier={setServiceTier}
          onPickReasoning={setReasoningEffort}
          mode={mode}
          onPickMode={setMode}
          autoFocus
          big
        />
      </div>

      <div />
    </div>
  );
}
