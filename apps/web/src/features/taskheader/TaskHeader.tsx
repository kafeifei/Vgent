import { useEffect, useState } from "react";
import { GitBranch, PanelRight, Square } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import { OutcomeBadge } from "@/components/OutcomeBadge";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ENGINES, PERMISSIONS } from "@/lib/engineOptions";
import type { EngineId, PermissionMode, ThreadSummary, ThreadWorkspace } from "@/lib/types";
import { cn } from "@/lib/utils";

const PILL_CLASS =
  "inline-flex h-xl min-w-0 flex-none items-center gap-2xs overflow-hidden rounded-full border border-border bg-bg-elevated px-xs text-fg-muted text-xs";

function Pill({
  label,
  value,
  ...props
}: { label: string; value: string } & React.ComponentProps<"button">) {
  return (
    <button type="button" {...props} className={cn(PILL_CLASS, "hover:border-border-strong hover:text-fg")}>
      <span className="flex-none text-fg-faint">{label}</span>
      <span className="min-w-0 truncate font-mono text-fg">{value}</span>
      <span className="flex-none opacity-60">▾</span>
    </button>
  );
}

/** The worktree pill: its branch, plus 已回收 once the directory is gone. */
function BranchPill({
  value,
  muted,
  ...props
}: { value: string; muted?: string } & React.ComponentProps<"button">) {
  return (
    <button type="button" {...props} className={cn(PILL_CLASS, "hover:border-border-strong hover:text-fg")}>
      <GitBranch className="size-md flex-none text-fg-faint" />
      <span className="min-w-0 truncate font-mono text-fg">{value}</span>
      {muted != null && <span className="flex-none text-fg-faint">{muted}</span>}
      <span className="flex-none opacity-60">▾</span>
    </button>
  );
}

/** That pill's popover: where the task's files are, and reclaim / restore. */
function WorkspaceMenu({
  workspace,
  running,
  onReclaim,
  onRestore,
  close,
}: {
  workspace: ThreadWorkspace;
  running: boolean;
  onReclaim: () => Promise<void>;
  onRestore: () => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const reclaimed = workspace.reclaimed === true;
  // Only a live run holds the directory open, which is the very condition the
  // server refuses a reclaim on (`runs.isRunning`).
  const blocked = busy || (!reclaimed && running);

  return (
    <>
      <PopTitle>工作目录</PopTitle>
      <div className="px-xs pb-2xs text-xs">
        <p className="m-0 select-text break-all font-mono text-fg-muted">{workspace.path}</p>
        <p className="m-0 mt-2xs text-fg-faint">
          分支 <span className="font-mono text-fg-muted">{workspace.branch}</span>
        </p>
        <p className="m-0 text-fg-faint">
          基线 <span className="font-mono text-fg-muted">{workspace.baseCommit.slice(0, 7)}</span>
        </p>
      </div>
      <PopItem
        disabled={blocked}
        {...(!reclaimed && running ? { hint: "任务运行中" } : {})}
        onClick={() => {
          setBusy(true);
          void (reclaimed ? onRestore() : onReclaim()).finally(() => {
            setBusy(false);
            close();
          });
        }}
      >
        {reclaimed ? "恢复工作目录" : "回收工作目录"}
      </PopItem>
    </>
  );
}

/** Sticky task header: title, engine / model / permission pills, stop, right pane. */
export function TaskHeader({
  thread,
  live,
  pending,
  rightOpen,
  onRename,
  onSetEngine,
  onSetModel,
  onSetPermission,
  onClearAlwaysAllow,
  onReclaimWorkspace,
  onRestoreWorkspace,
  onStop,
  onToggleRight,
  onBlocked,
}: {
  thread: ThreadSummary;
  live: boolean;
  pending: number;
  rightOpen: boolean;
  onRename: (title: string) => void;
  onSetEngine: (engine: EngineId) => void;
  onSetModel: (model: string | null) => void;
  onSetPermission: (mode: PermissionMode) => void;
  /** Empties the task's 「本任务内一直允许」 list. */
  onClearAlwaysAllow: () => void;
  onReclaimWorkspace: () => Promise<void>;
  onRestoreWorkspace: () => Promise<void>;
  onStop: () => void;
  onToggleRight: () => void;
  /** Called instead of a PATCH while the thread is running. */
  onBlocked: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  useEffect(() => setDraft(thread.title), [thread.title]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== "" && next !== thread.title) onRename(next);
    else setDraft(thread.title);
  };

  const guard = (run: () => void) => (live ? onBlocked() : run());
  const workspace = thread.workspace;

  return (
    <div className="flex items-start gap-xs border-border border-b bg-bg px-md py-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-xs">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(thread.title);
                setEditing(false);
              }
            }}
            className="min-w-0 max-w-[34ch] flex-none rounded-sm border border-border bg-bg-elevated px-2xs py-3xs font-semibold text-md outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={thread.title}
            className="min-w-0 max-w-[34ch] flex-none truncate rounded-sm border border-transparent px-2xs py-3xs text-left font-semibold text-md hover:border-border hover:bg-bg-elevated"
          >
            {thread.title}
          </button>
        )}

        <Popover
          trigger={(props) => {
            const engine = ENGINES.find((entry) => entry.id === thread.engine);
            return <Pill label="引擎" value={engine?.label ?? thread.engine} {...props} />;
          }}
        >
          {(close) => (
            <>
              <PopTitle>引擎</PopTitle>
              {ENGINES.map((engine) => (
                <PopItem
                  key={engine.id}
                  selected={engine.id === thread.engine}
                  onClick={() => {
                    guard(() => onSetEngine(engine.id));
                    close();
                  }}
                >
                  {engine.label}
                </PopItem>
              ))}
            </>
          )}
        </Popover>

        <ModelPicker
          engine={thread.engine}
          model={thread.model}
          onPick={(model) => guard(() => onSetModel(model))}
          trigger={(props, chip) => (
            <Pill label="模型" value={chip.label} {...(chip.title != null ? { title: chip.title } : {})} {...props} />
          )}
        />

        <Popover trigger={(props) => <Pill label="权限" value={thread.permissionMode} {...props} />}>
          {(close) => (
            <>
              <PopTitle>权限模式</PopTitle>
              {PERMISSIONS.map((mode) => {
                const codexLocked = thread.engine === "codex" && mode !== "allow-all";
                return (
                  <PopItem
                    key={mode}
                    selected={mode === thread.permissionMode}
                    disabled={codexLocked}
                    {...(codexLocked ? { hint: "Codex 只支持 allow-all" } : {})}
                    onClick={() => {
                      guard(() => onSetPermission(mode));
                      close();
                    }}
                  >
                    <span className="font-mono">{mode}</span>
                  </PopItem>
                );
              })}
              {(thread.alwaysAllow?.length ?? 0) > 0 && (
                <div className="flex items-center gap-xs px-xs py-2xs text-fg-faint text-xs">
                  <span className="min-w-0 flex-1 truncate">一直允许：{thread.alwaysAllow?.join(", ")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClearAlwaysAllow();
                      close();
                    }}
                    className="flex-none text-fg-muted hover:text-fg"
                  >
                    清除
                  </button>
                </div>
              )}
            </>
          )}
        </Popover>

        {workspace != null && (
          <Popover
            trigger={(props) => (
              <BranchPill
                value={workspace.branch}
                {...(workspace.reclaimed === true ? { muted: "已回收" } : {})}
                {...props}
              />
            )}
          >
            {(close) => (
              <WorkspaceMenu
                workspace={workspace}
                running={thread.status === "running"}
                onReclaim={onReclaimWorkspace}
                onRestore={onRestoreWorkspace}
                close={close}
              />
            )}
          </Popover>
        )}

        {thread.outcome != null && <OutcomeBadge outcome={thread.outcome} className="max-w-[24ch]" />}
      </div>

      <div className="ml-auto flex flex-none items-center gap-xs">
        {live && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex h-xl flex-none items-center gap-2xs whitespace-nowrap rounded-full border border-danger bg-danger-bg px-sm text-danger text-xs"
          >
            <Square className="size-md fill-current" />
            停止
          </button>
        )}

        <button
          type="button"
          aria-pressed={rightOpen}
          title="右栏 ⌘J"
          onClick={onToggleRight}
          className={cn(
            "relative grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg",
            rightOpen && "bg-bg-active text-fg",
          )}
        >
          <PanelRight className="size-lg" />
          {pending > 0 && (
            <span className="-top-3xs -right-3xs absolute grid h-md min-w-md place-items-center rounded-full bg-brand px-3xs font-bold font-mono text-2xs text-brand-fg">
              {pending}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
