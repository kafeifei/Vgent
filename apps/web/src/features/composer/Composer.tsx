import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { ArrowUp, Check, ChevronDown, File, FileText, Folder, Plus, Square, X } from "lucide-react";
import { UrlFigure } from "@/components/Figure";
import { ModelPicker, effectiveModel } from "@/components/ModelPicker";
import { dirName } from "@/features/changes/paths";
import { baseName } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { ChangedFile, EngineDescriptor, EngineId, FileEntry, ModelCatalog, PermissionMode, QueuedMessage, ThreadMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ComposerStatusBar } from "./ComposerStatusBar";
import { QueueStrip } from "./QueueStrip";
import { MAX_ATTACHMENT_BYTES, formatBytes, isImage, readAttachments, type Attachment } from "./attachments";
import { acceptMention, findMention, mentionSegments, type Mention } from "./mention";
import { findSlash, matchSlash, removeSlash, type Slash, type SlashCommand } from "./slash";
import { isImeKeyEvent } from "@/lib/ime";

export const COMPOSER_PLACEHOLDER = "规划、构建，/ 输入命令，@ 引用上下文";
const FOLLOW_UP_PLACEHOLDER = "继续追问";

/** 模式: what the next message does. One line each, because that is the whole choice. */
const MODES: ReadonlyArray<{ id: ThreadMode; label: string; hint: string }> = [
  { id: "agent", label: "Agent", hint: "直接动手" },
  { id: "plan", label: "Plan", hint: "先只读调研、出计划，你改完再 Build" },
];

/** Keystrokes settle before we ask the server for candidates. */
const COMPLETE_DEBOUNCE_MS = 120;
const MAX_ROWS = 12;

/**
 * The composer, shared by the thread view and the empty state.
 *
 * Inside the box: 「+」 (pick files to attach — pasting and dropping them works
 * too), the 模式 chip (only when the mode is not the default Agent), 模型, and
 * 发送 / 停止. 推理强度, 上下文 and Fast are rows of the 模型 menu rather than chips
 * of their own — one control for「跑什么、怎么跑」. 模式 itself is switched from the `/` menu or with ⇧Tab,
 * the way Cursor does it; `/` is also where the caller's own commands show up. Under the box, `ComposerStatusBar` carries
 * the task's ground — 分支, 运行位置, 审查 pill, and the context ring — because
 * 「在哪跑」 has to be readable in every task, not only while creating one. Above
 * the box there is nothing left but the queue and the 能力缺失 notice.
 *
 * `@` opens a file completion when `completeFiles` is given; the accepted
 * token is plain text in the sent message — the engines read the file itself.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  live,
  engines,
  engine,
  engineLocked,
  model,
  runMode,
  modelEngines,
  onRememberEngine,
  onPickModel,
  reasoningEffort,
  onPickReasoning,
  serviceTier,
  onPickServiceTier,
  contextWindow: chosenWindow,
  onPickContext,
  mode,
  onPickMode,
  queue,
  queueNote,
  onSendQueued,
  onInterruptWithQueued,
  onEditQueued,
  onDeleteQueued,
  onReorderQueued,
  onSteerQueued,
  branch,
  branchTitle,
  location,
  completeFiles,
  attachments,
  onAttachments,
  commands,
  messages,
  changedFiles,
  onOpenChanges,
  autoFocus = false,
  big = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (delivery?: "steer" | "queue") => void;
  onStop?: () => void;
  live: boolean;
  /** 引擎能力表, for the grouped model picker and the 「不支持审批」 notice. */
  engines: EngineDescriptor[];
  engine: EngineId;
  /** A task with history cannot cross engines; the picker greys the others out. */
  engineLocked?: boolean;
  model: string | undefined;
  /** The global 运行模式, so an engine that cannot ask can say so. */
  runMode?: PermissionMode | undefined;
  /** 记住上次选的引擎: `Settings.modelEngines`, and how the picker keeps a new choice. */
  modelEngines?: Readonly<Record<string, EngineId>> | undefined;
  onRememberEngine?: (modelKey: string, engine: EngineId) => void;
  onPickModel: (engine: EngineId, model: string | undefined) => void;
  reasoningEffort: string | undefined;
  onPickReasoning: (level: string) => void;
  /** The task's service tier (`priority` = Fast); unset is the standard one. */
  serviceTier: string | undefined;
  /** `null` goes back to standard. */
  onPickServiceTier: (tier: string | null) => void;
  /** 上下文: the window the task chose, in tokens; unset means the engine's own for the model. */
  contextWindow: number | undefined;
  onPickContext: (window: number | null) => void;
  /** 模式 of the next message. The chip and ⇧Tab both write it. */
  mode: ThreadMode;
  onPickMode: (mode: ThreadMode) => void;
  /** Pending steer and queue items, in their current order. */
  queue?: readonly QueuedMessage[];
  /** Why the queue is not moving — 已停止 / 出错 / 等审批. Absent while a turn runs. */
  queueNote?: string | undefined;
  /** 「发送」 on the head item. Absent while the task is live. */
  onSendQueued?: ((itemId: string) => void) | undefined;
  /** 「打断并发送」 on the head item. Present only while the task is live. */
  onInterruptWithQueued?: ((itemId: string) => void) | undefined;
  onEditQueued?: (itemId: string, text: string) => void;
  onDeleteQueued?: (itemId: string) => void;
  onReorderQueued?: (ids: readonly string[]) => void;
  onSteerQueued?: (itemId: string) => void;
  /** 分支 for the row under the box; absent on a detached HEAD or a non-repo. */
  branch?: string | undefined;
  branchTitle?: string | undefined;
  /** 运行位置 for that same row. Absent (the empty state, which has them above the box) drops the row. */
  location?: ReactNode;
  /** Absent (the empty state) leaves `@` inert. */
  completeFiles?: (q: string) => Promise<FileEntry[]>;
  /** 附件 waiting to go out with the next message; the caller owns them, as it owns the text. */
  attachments: readonly Attachment[];
  onAttachments: (next: Attachment[]) => void;
  /** The caller's rows for the `/` menu (压缩上下文, 新任务 …), listed after 模式. */
  commands?: readonly SlashCommand[];
  /** This task's history, for the context ring. Absent = no ring. */
  messages?: readonly UIMessage[];
  /** This task's working-tree changes, for the 审查 pill. Absent or empty = no pill. */
  changedFiles?: readonly ChangedFile[];
  onOpenChanges?: () => void;
  autoFocus?: boolean;
  big?: boolean;
}) {
  const toast = useToast();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  /** Set when an accepted mention has to move the caret after the re-render. */
  const pendingCaret = useRef<number | null>(null);

  const [mention, setMention] = useState<Mention | null>(null);
  const [rows, setRows] = useState<FileEntry[]>([]);
  const [active, setActive] = useState(0);
  /** Bumped per query; a stale response never writes state. */
  const generation = useRef(0);
  const open = mention != null && rows.length > 0;
  const [slash, setSlash] = useState<Slash | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * The ring's denominator, taken off the very list `ModelPicker` below loads —
   * measured against the model that will actually run, so「默认」gets a real
   * window too. `contextWindow` is undefined for sources that do not report one,
   * and the ring then says so itself.
   */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const running = effectiveModel(model, catalog);
  const runningEntry = catalog?.models.find((entry) => entry.id === running);
  // A window the model does not offer (it was picked for another) is not what runs.
  const contextWindow =
    chosenWindow != null && runningEntry?.contextOptions?.includes(chosenWindow) === true ? chosenWindow : runningEntry?.contextWindow;
  // A tier picked for another model does not follow the task onto one that
  // does not offer it: it would be sent, and the switch to undo it is gone.
  const staleTier =
    !live && runningEntry != null && serviceTier != null && runningEntry.serviceTiers?.some((tier) => tier.id === serviceTier) !== true;
  useEffect(() => {
    if (staleTier) onPickServiceTier(null);
  }, [onPickServiceTier, staleTier]);

  // 能力缺失就明说，不装：an engine that cannot ask gets a sentence, not a
  // control the user would only find out is dead by clicking it.
  const descriptor = engines.find((entry) => entry.id === engine);
  const noApprovals = descriptor != null && !descriptor.capabilities.approvals && runMode !== "allow-all";
  // Same rule for Plan: the row is dead rather than absent, and it says why.
  const planSupported = descriptor?.capabilities.planMode === true;
  const planReason = planSupported ? undefined : `${descriptor?.label ?? "这个引擎"} 不支持 Plan 模式`;
  const canSwitchMode = !live && planSupported;
  /** Leaving a non-default mode is allowed even where entering it no longer is. */
  const canLeaveMode = !live;
  // A typed follow-up uses the same button as an idle send. Once the caller
  // clears the accepted draft, a running task shows Stop again.
  const showSend = !live || value.trim().length > 0;

  /**
   * Picking another engine's model can take Plan away. Falling back silently
   * would run the next message in a mode the chip no longer shows, so it says so.
   */
  const pickModel = (nextEngine: EngineId, nextModel: string | undefined): void => {
    onPickModel(nextEngine, nextModel);
    const next = engines.find((entry) => entry.id === nextEngine);
    if (mode !== "plan" || next == null || next.capabilities.planMode) return;
    onPickMode("agent");
    toast(`${next.label} 不支持 Plan 模式，已切回 Agent`);
  };

  // A draft that just went out (or was cleared by a command) leaves the caret
  // where it was: in the box, ready for the next message — also when the send
  // came from somewhere that took the focus away.
  const previousValue = useRef(value);
  useEffect(() => {
    const sent = previousValue.current !== "" && value === "";
    previousValue.current = value;
    if (sent) textarea.current?.focus();
  }, [value]);

  // Auto-grow: reset, then take the content height.
  useEffect(() => {
    const element = textarea.current;
    if (element == null) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    const caret = pendingCaret.current;
    if (caret == null) return;
    pendingCaret.current = null;
    element.focus();
    element.setSelectionRange(caret, caret);
  }, [value]);

  const query = mention?.query ?? null;

  useEffect(() => {
    const mine = ++generation.current;
    if (completeFiles == null || query == null) {
      setRows([]);
      return;
    }
    const timer = setTimeout(() => {
      completeFiles(query)
        .then((next) => {
          if (mine !== generation.current) return;
          setRows(next.slice(0, MAX_ROWS));
          setActive(0);
        })
        .catch(() => {
          if (mine === generation.current) setRows([]);
        });
    }, COMPLETE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [completeFiles, query]);

  const segments = useMemo(() => mentionSegments(value), [value]);

  const accept = (entry: FileEntry): void => {
    if (mention == null) return;
    const next = acceptMention(value, mention, entry);
    setMention(null);
    setRows([]);
    pendingCaret.current = next.caret;
    onChange(next.text);
  };

  /**
   * The `/` menu: 模式 first, then whatever the caller offers. A mode that
   * cannot be entered is listed with its reason rather than left out.
   */
  const slashRows = useMemo<SlashCommand[]>(() => {
    if (slash == null) return [];
    const modes: SlashCommand[] = MODES.map((entry) => {
      const blocked = entry.id === "plan" && !planSupported ? planReason : !canLeaveMode && entry.id !== mode ? "运行中不能切换" : undefined;
      return {
        id: entry.id,
        label: entry.label,
        hint: entry.hint,
        section: "模式",
        selected: entry.id === mode,
        disabledReason: blocked,
        run: () => onPickMode(entry.id),
      };
    });
    return matchSlash([...modes, ...(commands ?? [])], slash.query);
  }, [canLeaveMode, commands, mode, onPickMode, planReason, planSupported, slash]);
  const slashOpen = slash != null && slashRows.length > 0;

  const runSlash = (command: SlashCommand): void => {
    if (slash == null || command.disabledReason != null) return;
    const next = removeSlash(value, slash);
    setSlash(null);
    pendingCaret.current = next.caret;
    onChange(next.text);
    command.run();
  };

  /** Picked, pasted or dropped: all three land here. */
  const addFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    void readAttachments(files).then(
      ({ attachments: added, rejected }) => {
        if (added.length > 0) onAttachments([...attachments, ...added]);
        if (rejected.length > 0) toast(`${rejected.join("、")} 超过 ${formatBytes(MAX_ATTACHMENT_BYTES)}，没有添加`);
      },
      (error: unknown) => toast(error instanceof Error ? error.message : "读取文件失败"),
    );
  };

  return (
    <div className="mx-auto w-full max-w-log-max">
      {noApprovals && (
        <div className="flex min-h-review-bar items-center pb-2xs">
          <span className="min-w-0 truncate text-fg-faint text-xs">
            {descriptor?.label} 不支持审批，这个任务会全自动运行
          </span>
        </div>
      )}

      <div
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          setDragging(false);
          addFiles([...event.dataTransfer.files]);
        }}
        className={cn(
          "relative rounded-2xl border border-border bg-bg-elevated shadow-xs focus-within:border-border-strong",
          dragging && "border-border-strong bg-bg-inset",
        )}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            // The same file picked twice in a row must still fire `change`.
            event.target.value = "";
          }}
        />

        {slashOpen && (
          <div className="absolute bottom-full left-0 z-10 mb-2xs max-h-[calc(var(--spacing-xl)*10)] w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated p-2xs shadow-lg">
            {slashRows.map((command, index) => (
              <div key={command.id}>
                {command.section !== slashRows[index - 1]?.section && (
                  <div className="px-xs pt-2xs pb-3xs text-fg-faint text-xs">{command.section}</div>
                )}
                <button
                  type="button"
                  disabled={command.disabledReason != null}
                  title={command.disabledReason}
                  // `mousedown`, so the textarea never loses focus to the click.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    runSlash(command);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex min-h-row w-full items-center gap-xs rounded-md px-xs text-left text-body disabled:cursor-not-allowed disabled:opacity-50",
                    index === active ? "bg-bg-active" : "hover:bg-bg-hover",
                  )}
                >
                  <span className="flex-none text-fg">{command.label}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-faint text-sm">{command.disabledReason ?? command.hint}</span>
                  {command.selected === true && <Check className="size-md flex-none text-fg-muted" />}
                  <span className="flex-none font-mono text-fg-faint text-xs">/{command.id}</span>
                </button>
              </div>
            ))}
          </div>
        )}

        {open && (
          <div className="absolute bottom-full left-0 z-10 mb-2xs max-h-[calc(var(--spacing-xl)*8)] w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated p-2xs shadow-lg">
            {rows.map((entry, index) => (
              <button
                key={entry.path}
                type="button"
                title={entry.path}
                // `mousedown`, so the textarea never loses focus to the click.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(entry);
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  "flex h-row-file w-full items-center gap-2xs rounded-md px-xs text-left",
                  index === active ? "bg-bg-inset" : "hover:bg-bg-hover",
                )}
              >
                {entry.kind === "dir" ? (
                  <Folder className="size-md flex-none text-fg-faint" />
                ) : (
                  <File className="size-md flex-none text-fg-faint" />
                )}
                <span className="flex-none font-medium font-mono text-code text-fg">{baseName(entry.path)}</span>
                <span className="min-w-0 truncate font-mono text-2xs text-fg-faint">{dirName(entry.path)}</span>
              </button>
            ))}
          </div>
        )}

        {queue != null && queue.length > 0 && onEditQueued != null && onDeleteQueued != null && (
          <QueueStrip
            items={queue}
            note={queueNote}
            onSend={onSendQueued}
            onInterrupt={onInterruptWithQueued}
            onEdit={onEditQueued}
            onDelete={onDeleteQueued}
            onReorder={onReorderQueued}
            onSteer={onSteerQueued}
          />
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-xs px-sm pt-sm">
            {attachments.map((entry) => (
              <div
                key={entry.id}
                title={`${entry.name} · ${formatBytes(entry.size)}`}
                className="group/tile relative flex h-12 max-w-[24ch] flex-none items-center overflow-hidden rounded-lg border border-border bg-bg-inset"
              >
                {isImage(entry.mediaType) ? (
                  <UrlFigure
                    src={entry.url}
                    alt={entry.name}
                    wrapperClassName="my-0 size-12"
                    thumbnailClassName="size-12 rounded-none border-0 object-cover shadow-none"
                  />
                ) : (
                  <span className="flex min-w-0 items-center gap-xs px-sm text-fg-secondary text-sm">
                    <FileText className="size-lg flex-none text-fg-muted" />
                    <span className="min-w-0 truncate">{entry.name}</span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`移除 ${entry.name}`}
                  onClick={() => onAttachments(attachments.filter((other) => other.id !== entry.id))}
                  className="absolute top-3xs right-3xs grid size-lg place-items-center rounded-full bg-fg text-bg opacity-0 focus-visible:opacity-100 group-hover/tile:opacity-100"
                >
                  <X className="size-sm" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={cn("flex items-end gap-2xs p-1.25", big && "flex-wrap px-xs pt-xs")}>
          {/* 「+」 picks files, nothing else. Pasting or dropping them onto the
              box does the same; 模式 lives in the `/` menu. */}
          <button
            type="button"
            aria-label="添加文件"
            title="添加文件或图片（也可以直接粘贴、拖进来）"
            onClick={() => fileInput.current?.click()}
            className="grid size-7 flex-none place-items-center rounded-full bg-bg-active text-fg-muted hover:bg-bg-strong hover:text-fg"
          >
            <Plus className="size-lg" />
          </button>
          <div className={cn("relative min-w-0 flex-1", big && "order-first basis-full")}>
            {/* The pill layer: the textarea's own text is transparent above it. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2xs py-3xs text-fg text-md leading-chat"
            >
              {segments.map((segment, index) => (
                // The index is the identity: the list is rebuilt from the text.
                // The pill's padding is cancelled by an equal negative margin —
                // anything that moved a glyph would drift from the real caret.
                <span key={index} className={segment.mention ? "-mx-3xs rounded bg-bg-inset px-3xs text-fg" : undefined}>
                  {segment.text}
                </span>
              ))}
              {"\n"}
            </div>

            <textarea
              ref={textarea}
              value={value}
              autoFocus={autoFocus}
              rows={1}
              placeholder={big ? COMPOSER_PLACEHOLDER : FOLLOW_UP_PLACEHOLDER}
              onChange={(event) => {
                onChange(event.target.value);
                const caret = event.target.selectionStart;
                const nextSlash = findSlash(event.target.value, caret);
                // A fresh query starts from the top of whichever list it opens.
                if (nextSlash?.query !== slash?.query) setActive(0);
                setSlash(nextSlash);
                setMention(completeFiles == null ? null : findMention(event.target.value, caret));
              }}
              onBlur={() => {
                setMention(null);
                setSlash(null);
              }}
              onPaste={(event) => {
                // Text pastes as text. Only a clipboard that carries files —
                // a screenshot, something copied in Finder — becomes 附件.
                const files = [...event.clipboardData.files];
                if (files.length === 0) return;
                event.preventDefault();
                addFiles(files);
              }}
              onKeyDown={(event) => {
                // A key the input method is still using is not ours: confirming a
                // candidate with Enter must not send, arrows must not move our list.
                if (isImeKeyEvent(event)) return;
                if (slashOpen) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setActive((index) => (index + step + slashRows.length) % slashRows.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSlash(null);
                    return;
                  }
                  // Enter runs the row; it must not also send the turn.
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const command = slashRows[Math.min(active, slashRows.length - 1)];
                    if (command != null) runSlash(command);
                    return;
                  }
                }
                if (open) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActive((index) => (index + 1) % rows.length);
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActive((index) => (index - 1 + rows.length) % rows.length);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setMention(null);
                    return;
                  }
                  // Enter picks a candidate here; it must not also send the turn.
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    const entry = rows[active];
                    if (entry != null) accept(entry);
                    return;
                  }
                }
                // ⇧Tab switches 模式. `preventDefault` only when it really does —
                // otherwise the key keeps its normal job of leaving the textarea.
                if (event.key === "Tab" && event.shiftKey) {
                  if (!canSwitchMode) return;
                  event.preventDefault();
                  onPickMode(mode === "plan" ? "agent" : "plan");
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSubmit(event.metaKey ? "queue" : "steer");
                }
              }}
              className={cn(
                "relative block max-h-[40vh] w-full resize-none bg-transparent px-2xs py-3xs text-md text-transparent caret-fg leading-chat outline-none placeholder:text-fg-faint",
                big && "min-h-[calc(var(--leading-chat)*3)]",
              )}
            />
          </div>
          {/* 模式 chip, only away from the default: what the next message does
              differently has to be readable, and one × puts it back. */}
          {mode !== "agent" && (
            <span className="inline-flex h-7 flex-none items-center gap-3xs rounded-full bg-brand-bg pr-2xs pl-sm text-brand text-sm">
              <span title={MODES.find((entry) => entry.id === mode)?.hint}>
                {MODES.find((entry) => entry.id === mode)?.label}
              </span>
              <button
                type="button"
                aria-label="回到 Agent 模式"
                title="回到 Agent 模式（⇧Tab）"
                disabled={!canLeaveMode}
                onClick={() => onPickMode("agent")}
                className="grid size-md place-items-center rounded-full hover:bg-bg-active disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="size-xs" />
              </button>
            </span>
          )}
          <ModelPicker
            engines={engines}
            engine={engine}
            model={model}
            options={{ reasoningEffort, serviceTier, contextWindow: chosenWindow }}
            {...(engineLocked === true ? { engineLocked: true } : {})}
            onPick={pickModel}
            onPickOptions={(patch) => {
              if (patch.reasoningEffort != null) onPickReasoning(patch.reasoningEffort);
              if ("serviceTier" in patch) onPickServiceTier(patch.serviceTier ?? null);
              if ("contextWindow" in patch) onPickContext(patch.contextWindow ?? null);
            }}
            {...(modelEngines != null ? { modelEngines } : {})}
            {...(onRememberEngine != null ? { onRememberEngine } : {})}
            onCatalog={setCatalog}
            commitDefault={!live}
            side="top"
            trigger={(props, chip) => (
              <button
                type="button"
                {...(chip.title != null ? { title: chip.title } : {})}
                {...props}
                className="inline-flex h-7 flex-none items-center gap-3xs rounded-full px-xs text-fg-muted text-sm hover:bg-bg-hover hover:text-fg"
              >
                <span className="max-w-[36ch] truncate">{chip.label}</span>
                <ChevronDown className="size-sm flex-none text-fg-faint" />
              </button>
            )}
          />
          {big && <span className="flex-1" />}
          {/* A typed follow-up is sent as guidance. An empty composer keeps Stop. */}
          <button
            type="button"
            aria-label={showSend ? (live ? "发送引导" : "发送") : "停止"}
            title={showSend && live ? "发送引导（⌘↵ 排队）" : undefined}
            onClick={() => {
              if (showSend) onSubmit("steer");
              else onStop?.();
              // The click took the focus; the next message is typed without reaching for the mouse.
              textarea.current?.focus();
            }}
            className="grid size-7 flex-none place-items-center rounded-full bg-fg text-bg hover:opacity-85"
          >
            {showSend ? <ArrowUp className="size-lg" /> : <Square className="size-sm fill-current" />}
          </button>
        </div>
      </div>

      {location != null && (
        <ComposerStatusBar
          {...(branch != null ? { branch } : {})}
          {...(branchTitle != null ? { branchTitle } : {})}
          location={location}
          {...(changedFiles != null ? { changedFiles } : {})}
          {...(onOpenChanges != null ? { onOpenChanges } : {})}
          {...(messages != null ? { messages } : {})}
          {...(contextWindow != null ? { contextWindow } : {})}
        />
      )}
    </div>
  );
}
