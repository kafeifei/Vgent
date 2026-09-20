import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { ChevronDown } from "lucide-react";
import { toFileParts, type Attachment } from "@/features/composer/attachments";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ProjectPicker } from "@/components/ProjectPicker";
import { Composer } from "@/features/composer/Composer";
import type { ApiClient } from "@/lib/api";
import type { DraftTransport } from "@/lib/drafts";
import { NEW_TASK_DRAFT, useDraft } from "@/lib/drafts";
import { useToast } from "@/lib/toast";
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
 * 「配置 + 输入」, not 「欢迎语 + 建议」. Four choices and no more: 项目 above the
 * composer, 模型 and 思考等级 inside it, 运行位置 in the row under it — the same
 * row every task then keeps, so 「在哪跑」 sits in one place for good. 运行模式 is
 * a global setting now, so there is no permission control here at all.
 */
export function EmptyState({
  projects,
  projectId,
  engines,
  settings,
  client,
  onSelectProject,
  onAddProject,
  onPickFolder,
  onStart,
}: {
  projects: Project[];
  projectId: string | null;
  engines: EngineDescriptor[];
  settings: Settings | null;
  /**
   * The draft routes — this screen's draft lives on the server like every
   * other — plus the project's current branch, for the row under the composer.
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
    files: FileUIPart[],
    serviceTier: string | null,
    contextWindow: number | null,
  ) => Promise<boolean>;
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

  /**
   * The branch the row under the composer names: whichever one this checkout is
   * on, because that is both where a 主目录 task would write and what a worktree
   * task would be cut from. Fetched per project; a repo we cannot read simply
   * has no branch to show.
   */
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    setBranch(null);
    if (projectId == null) return;
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

  const engine = picked?.engine ?? settings?.defaultEngine ?? engines[0]?.id;
  // `null` means「用默认」: the server falls back to `settings.defaultModel`.
  const model = picked?.model ?? (picked == null ? (settings?.defaultModel ?? null) : null);

  /** One in-flight start at a time: the text stays until the task really exists. */
  const starting = useRef(false);
  // 附件 are not part of the saved draft: they are large, and a file picked for
  // a task that was never started is not worth keeping on the server.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const submit = () => {
    if (engine == null || starting.current) return;
    const text = draft.value.trim();
    if (text === "" && attachments.length === 0) return;
    if (project == null) {
      toast("先选一个项目");
      return;
    }
    starting.current = true;
    void onStart(text, engine, workspace, model, reasoningEffort, mode, toFileParts(attachments), serviceTier, contextWindow).then((started) => {
      starting.current = false;
      if (!started) return;
      draft.clear();
      setAttachments([]);
    });
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
                <ChevronDown className="size-sm flex-none text-fg-faint" />
              </button>
            )}
          />
        </div>
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
          onPickModel={(nextEngine, nextModel) => {
            setPicked({ engine: nextEngine, model: nextModel ?? null });
            setReasoningEffort(null);
            // A window belongs to the model it was picked for.
            setContextWindow(null);
          }}
          contextWindow={contextWindow ?? undefined}
          onPickContext={setContextWindow}
          reasoningEffort={reasoningEffort ?? undefined}
          serviceTier={serviceTier ?? undefined}
          onPickServiceTier={setServiceTier}
          onPickReasoning={setReasoningEffort}
          mode={mode}
          onPickMode={setMode}
          {...(branch != null ? { branch } : {})}
          branchTitle={
            workspace === "worktree"
              ? "新任务从这个分支已提交的 HEAD 开出独立检出"
              : "新任务直接改这个检出里的文件"
          }
          // 运行位置：一个选择器，两个值。它决定这个任务改谁的文件。这里是
          // 唯一还能改它的地方——任务建出来之后它就定了。
          location={
            <Popover
              className="max-w-[calc(var(--spacing-3xl)*8)]"
              side="top"
              trigger={(props) => (
                <button
                  type="button"
                  {...props}
                  title="这个任务在哪里改文件"
                  className="inline-flex h-xl items-center gap-3xs rounded-md px-2xs hover:bg-bg-hover hover:text-fg"
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
          }
          autoFocus
          big
        />
      </div>

      <div />
    </div>
  );
}
