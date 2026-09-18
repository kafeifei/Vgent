import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ArrowUp, File, Folder, Plus, Square } from "lucide-react";
import { ModelPicker, effectiveModel } from "@/components/ModelPicker";
import { PopItem, PopTitle, Popover } from "@/components/Popover";
import { ReasoningPicker } from "@/components/ReasoningPicker";
import { dirName } from "@/features/changes/paths";
import { baseName } from "@/lib/format";
import { useToast } from "@/lib/toast";
import type { ChangedFile, EngineDescriptor, EngineId, FileEntry, ModelCatalog, PermissionMode, ThreadMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ContextRing } from "./ContextRing";
import { sumChanges } from "./contextUsage";
import { acceptMention, findMention, mentionSegments, type Mention } from "./mention";

export const COMPOSER_PLACEHOLDER = "规划、构建，/ 输入命令，@ 引用上下文";

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
 * The review bar above it carries the task's 「改动收口」: the 运行位置 label,
 * the 审查 pill, and the context ring at the right end. The empty state has no
 * task, so it passes neither `messages` nor `changedFiles` and the row falls
 * back to the label alone — the location the new task will run in.
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
  onPickModel,
  reasoningEffort,
  onPickReasoning,
  mode,
  onPickMode,
  location,
  completeFiles,
  messages,
  changedFiles,
  onOpenChanges,
  autoFocus = false,
  big = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
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
  onPickModel: (engine: EngineId, model: string | undefined) => void;
  reasoningEffort: string | undefined;
  onPickReasoning: (level: string) => void;
  /** 模式 of the next message. The chip and ⇧Tab both write it. */
  mode: ThreadMode;
  onPickMode: (mode: ThreadMode) => void;
  /** Where this task runs, spelled out: 「主目录」 or 「worktree · <分支>」. */
  location: string;
  /** Absent (the empty state) leaves `@` inert, and hides the 「+」 button. */
  completeFiles?: (q: string) => Promise<FileEntry[]>;
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

  /**
   * The ring's denominator, taken off the very list `ModelPicker` below loads —
   * measured against the model that will actually run, so「默认」gets a real
   * window too. `contextWindow` is undefined for sources that do not report one,
   * and the ring then says so itself.
   */
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const running = effectiveModel(model, catalog);
  const contextWindow = catalog?.models.find((entry) => entry.id === running)?.contextWindow;
  const sums = useMemo(() => (changedFiles == null ? null : sumChanges(changedFiles)), [changedFiles]);

  // 能力缺失就明说，不装：an engine that cannot ask gets a sentence, not a
  // control the user would only find out is dead by clicking it.
  const descriptor = engines.find((entry) => entry.id === engine);
  const noApprovals = descriptor != null && !descriptor.capabilities.approvals && runMode !== "allow-all";
  // Same rule for Plan: the chip is dead rather than absent, and it says why.
  const planSupported = descriptor?.capabilities.planMode === true;
  const planReason = planSupported ? undefined : `${descriptor?.label ?? "这个引擎"} 不支持 Plan 模式`;
  const canSwitchMode = !live && planSupported;

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

  /** 「+」: type the `@` for the user, at the caret, and open the completion. */
  const insertMention = (): void => {
    const element = textarea.current;
    const caret = element?.selectionStart ?? value.length;
    const head = value.slice(0, caret);
    const token = `${head === "" || /\s$/.test(head) ? "" : " "}@`;
    const next = head + token + value.slice(caret);
    const position = caret + token.length;
    pendingCaret.current = position;
    onChange(next);
    setMention(findMention(next, position));
  };

  return (
    <div className="mx-auto w-full max-w-log-max">
      <div className="flex min-h-review-bar items-center gap-2xs pb-2xs">
        <span
          title="这个任务在哪里改文件"
          className="inline-flex h-xl items-center rounded-full border border-border bg-bg-elevated px-sm text-fg-muted text-xs"
        >
          {location}
        </span>
        {noApprovals && (
          <span className="min-w-0 truncate text-fg-faint text-xs">{descriptor?.label} 不支持审批，这个任务会全自动运行</span>
        )}
        {sums != null && sums.files > 0 && (
          <button
            type="button"
            title={`${sums.files} 个文件有改动，点开右栏逐个看 diff`}
            onClick={onOpenChanges}
            className="inline-flex h-xl items-center gap-2xs rounded-full border border-border bg-bg-elevated px-sm text-fg-muted text-xs hover:border-border-strong hover:text-fg"
          >
            <span>审查</span>
            <span className="font-mono text-diff-add-fg">+{sums.additions}</span>
            <span className="font-mono text-diff-del-fg">−{sums.deletions}</span>
          </button>
        )}
        {messages != null && <ContextRing messages={messages} {...(contextWindow != null ? { contextWindow } : {})} />}
      </div>

      <div className="relative rounded-lg border border-border bg-bg-elevated focus-within:border-border-strong">
        {open && (
          <div className="absolute bottom-full left-0 z-10 mb-2xs max-h-[calc(var(--spacing-xl)*8)] w-full overflow-y-auto rounded-md border border-border bg-bg-elevated shadow-lg">
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
                  "flex h-row-file w-full items-center gap-2xs px-xs text-left",
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

        <div className="relative">
          {/* The pill layer: the textarea's own text is transparent above it. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-md py-sm text-body text-fg leading-body"
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
            rows={2}
            placeholder={COMPOSER_PLACEHOLDER}
            onChange={(event) => {
              onChange(event.target.value);
              setMention(completeFiles == null ? null : findMention(event.target.value, event.target.selectionStart));
            }}
            onBlur={() => setMention(null)}
            onKeyDown={(event) => {
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
                  if (event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  const entry = rows[active];
                  if (entry != null) accept(entry);
                  return;
                }
              }
              // ⇧Tab switches 模式. `preventDefault` only when it really does —
              // otherwise the key keeps its normal job of leaving the textarea.
              if (event.key === "Tab" && event.shiftKey && !event.nativeEvent.isComposing) {
                if (!canSwitchMode) return;
                event.preventDefault();
                onPickMode(mode === "plan" ? "agent" : "plan");
                return;
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                // 排队是 M5 的事；在那之前 Enter 只提示，绝不清掉草稿。
                if (live) {
                  toast("运行中，先停止或等它结束");
                  return;
                }
                onSubmit();
              }
            }}
            className={cn(
              "relative block w-full resize-none bg-transparent px-md py-sm text-body text-transparent caret-fg leading-body outline-none placeholder:text-fg-faint",
              big ? "min-h-[calc(var(--spacing-xl)*3)]" : "min-h-[calc(var(--spacing-xl)*2)]",
            )}
          />
        </div>

        <div className="flex items-center gap-2xs px-xs pt-2xs pb-xs">
          {completeFiles != null && (
            <button
              type="button"
              aria-label="添加上下文"
              title="引用一个文件"
              onClick={insertMention}
              className="grid size-xl flex-none place-items-center rounded-full bg-bg-inset text-fg-muted hover:bg-bg-active hover:text-fg"
            >
              <Plus className="size-md" />
            </button>
          )}
          {/* 模式 chip. Plan is the quiet accent: which mode the next message
              runs in has to be readable without opening anything. */}
          <Popover
            className="max-w-[calc(var(--spacing-3xl)*8)]"
            side="top"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                disabled={!canSwitchMode}
                {...(planReason != null ? { title: planReason } : { title: "⇧Tab 切换模式" })}
                className={cn(
                  "inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-xs disabled:cursor-not-allowed disabled:opacity-50",
                  mode === "plan" ? "bg-brand-bg text-brand" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
                )}
              >
                <span>{MODES.find((entry) => entry.id === mode)?.label}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <PopTitle>模式</PopTitle>
                {MODES.map((entry) => (
                  <PopItem
                    key={entry.id}
                    selected={entry.id === mode}
                    onClick={() => {
                      onPickMode(entry.id);
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
          <ModelPicker
            engines={engines}
            engine={engine}
            model={model}
            {...(engineLocked === true ? { engineLocked: true } : {})}
            onPick={pickModel}
            onCatalog={setCatalog}
            side="top"
            trigger={(props, chip) => (
              <button
                type="button"
                {...(chip.title != null ? { title: chip.title } : {})}
                {...props}
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
              >
                <span className="font-mono">{chip.label}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          />
          <ReasoningPicker
            engine={engine}
            model={model}
            level={reasoningEffort}
            onPick={onPickReasoning}
            side="top"
            trigger={(props, current) => (
              <button
                type="button"
                {...props}
                title="思考等级"
                className="inline-flex h-xl items-center gap-3xs rounded-sm px-xs text-fg-muted text-xs hover:bg-bg-hover hover:text-fg"
              >
                <span>思考 {current}</span>
                <span className="opacity-60">▾</span>
              </button>
            )}
          />
          <span className="flex-1" />
          <button
            type="button"
            aria-label={live ? "停止" : "发送"}
            onClick={() => (live ? onStop?.() : onSubmit())}
            className="grid size-2xl flex-none place-items-center rounded-full bg-brand text-brand-fg hover:bg-brand-hover"
          >
            {live ? <Square className="size-md fill-current" /> : <ArrowUp className="size-lg" />}
          </button>
        </div>
      </div>
    </div>
  );
}
