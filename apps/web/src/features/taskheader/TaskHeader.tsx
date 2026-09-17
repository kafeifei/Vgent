import { useEffect, useState } from "react";
import { PanelRight, Square } from "lucide-react";
import { ModelPicker, modelLabel } from "@/components/ModelPicker";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import type { PermissionMode, ThreadSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const ENGINES: ReadonlyArray<{ id: string; label: string; wired: boolean }> = [
  { id: "claude-code", label: "Claude Code", wired: true },
  { id: "codex", label: "Codex", wired: false },
  { id: "vgent", label: "Vgent", wired: false },
];

const PERMISSIONS: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];

function Pill({
  label,
  value,
  ...props
}: { label: string; value: string } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="inline-flex h-xl min-w-0 flex-none items-center gap-2xs overflow-hidden rounded-full border border-border bg-bg-elevated px-xs text-fg-muted text-xs hover:border-border-strong hover:text-fg"
    >
      <span className="flex-none text-fg-faint">{label}</span>
      <span className="min-w-0 truncate font-mono text-fg">{value}</span>
      <span className="flex-none opacity-60">▾</span>
    </button>
  );
}

/** Sticky task header: title, engine / model / permission pills, stop, right pane. */
export function TaskHeader({
  thread,
  live,
  pending,
  rightOpen,
  onRename,
  onSetModel,
  onSetPermission,
  onStop,
  onToggleRight,
  onBlocked,
}: {
  thread: ThreadSummary;
  live: boolean;
  pending: number;
  rightOpen: boolean;
  onRename: (title: string) => void;
  onSetModel: (model: string | null) => void;
  onSetPermission: (mode: PermissionMode) => void;
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

  return (
    <div className="flex min-w-0 items-center gap-xs border-border border-b bg-bg px-md py-xs">
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
        {() => (
          <>
            <PopTitle>引擎</PopTitle>
            {ENGINES.map((engine) => (
              <PopItem
                key={engine.id}
                selected={engine.id === thread.engine}
                disabled={!engine.wired}
                {...(engine.wired ? {} : { hint: "未接线" })}
              >
                {engine.label}
              </PopItem>
            ))}
          </>
        )}
      </Popover>

      <ModelPicker
        model={thread.model}
        onPick={(model) => guard(() => onSetModel(model))}
        trigger={(props) => <Pill label="模型" value={modelLabel(thread.model)} {...props} />}
      />

      <Popover trigger={(props) => <Pill label="权限" value={thread.permissionMode} {...props} />}>
        {(close) => (
          <>
            <PopTitle>权限模式</PopTitle>
            {PERMISSIONS.map((mode) => (
              <PopItem
                key={mode}
                selected={mode === thread.permissionMode}
                onClick={() => {
                  guard(() => onSetPermission(mode));
                  close();
                }}
              >
                <span className="font-mono">{mode}</span>
              </PopItem>
            ))}
          </>
        )}
      </Popover>

      <span className="flex-1" />

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
  );
}
