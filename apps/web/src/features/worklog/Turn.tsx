import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { Check, ChevronDown, Copy } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  LIVE_REASON,
  type AskUserQuestionsInput,
  type AskUserQuestionsOutput,
  type CheckpointPreview,
  type ThreadMessageMetadata,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Spinner, ToolRow } from "./ToolRow";
import type { Block, Run, Turn as TurnModel } from "./turns";
import { approvalAnchor, compactedOf, isOpenApproval, isOpenQuestion, questionAnchor, runsOf } from "./turns";

export interface TurnActions {
  respondToApproval: (approvalId: string, approved: boolean) => void;
  /** Approve this call and add these entries to the global allowlist. */
  alwaysAllow: (approvalId: string, entries: string[]) => void;
  answerQuestions: (toolCallId: string, output: AskUserQuestionsOutput) => void;
  openFile: (file: string) => void;
  /**
   * 恢复到此处: put the files back to the state before this message ran. On a
   * dimmed message it is the same call read forwards — the server works out the
   * direction from where the thread stands.
   */
  restoreCheckpoint: (messageId: string) => void;
  /** 回到最新: undo the restore for good. */
  restoreLatest: () => void;
  /** What that restore would move, asked for only once the user opens the confirm. */
  previewRestore: (messageId: string) => Promise<CheckpointPreview>;
}

/** Sticks the newest user box to the top of the log and shadows it once stuck. */
function usePinned(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element == null) return;
    const observer = new IntersectionObserver(([entry]) => setPinned(entry != null && entry.intersectionRatio < 1), {
      threshold: [1],
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  return { ref, pinned };
}

export function Turn({
  turn,
  isLast,
  live,
  dimmed,
  atRestorePoint,
  actions,
  allowlist,
}: {
  turn: TurnModel;
  isLast: boolean;
  live: boolean;
  /** This turn sits at or after the restore point: it happened, but its files are not on disk. */
  dimmed: boolean;
  /** This is the turn the working directory was put back to; the bar above it says so. */
  atRestorePoint: boolean;
  actions: TurnActions;
  allowlist: readonly string[];
}) {
  const { ref, pinned } = usePinned(isLast);
  // A finished turn folds its process blocks away; the running one stays open.
  const folded = !(isLast && live);
  // A `/compact` summary is an ordinary user message apart from this marker.
  const compacted = turn.user == null ? undefined : compactedOf(turn.user);
  // Every turn a user message started has one, unless the task's directory is
  // not a git repo — then there is nothing to offer and nothing to say about it.
  const checkpoint = (turn.user?.metadata as ThreadMessageMetadata | undefined)?.checkpoint;

  return (
    <section className={cn("flex flex-col gap-block-gap pb-xl text-md leading-chat", dimmed && "opacity-45")}>
      {turn.user != null && (
        <div
          ref={ref}
          className={cn(
            "group rounded-xl border border-border bg-bg-elevated px-chat-inset py-sm shadow-xs",
            isLast && "sticky top-0 z-2",
            pinned && "shadow-sm",
          )}
        >
          {compacted != null && <p className="m-0 mb-2xs text-fg-muted text-xs">上下文已压缩（原 {compacted.before} 条消息）</p>}
          {turn.user.parts.map((part, index) =>
            part.type === "text" ? (
              <p key={index} className="m-0 whitespace-pre-wrap">
                {part.text}
              </p>
            ) : null,
          )}
          {/* The message the tree already stands at has nowhere to go; the bar
              above it carries 「回到最新」 instead. */}
          {checkpoint != null && !atRestorePoint && (
            <RestoreAction
              live={live}
              forward={dimmed}
              onPreview={() => actions.previewRestore(turn.user!.id)}
              onRestore={() => actions.restoreCheckpoint(turn.user!.id)}
            />
          )}
        </div>
      )}

      {runsOf(turn.blocks).map((run) =>
        run.kind === "foldable" && folded ? (
          <Fold key={run.key} run={run} actions={actions} allowlist={allowlist} />
        ) : (
          <div key={run.key} className="flex flex-col gap-block-gap px-chat-inset">
            {run.blocks.map((block, index) => (
              <BlockView
                key={block.key}
                block={block}
                actions={actions}
                allowlist={allowlist}
                running={live && isLast && index === run.blocks.length - 1}
              />
            ))}
          </div>
        ),
      )}
      {folded && <ReplyActions turn={turn} />}
    </section>
  );
}

/** The quiet row under a finished reply. 复制 takes the reply's text, not the process above it. */
function ReplyActions({ turn }: { turn: TurnModel }) {
  const [copied, setCopied] = useState(false);
  const text = turn.blocks
    .flatMap((block) => (block.kind === "text" ? [block.part.text] : []))
    .join("\n\n")
    .trim();
  if (text === "") return null;
  return (
    <div className="-mt-xs flex items-center gap-2xs px-chat-inset text-fg-faint">
      <button
        type="button"
        aria-label="复制回复"
        title={copied ? "已复制" : "复制回复"}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="-ml-2xs grid size-xl place-items-center rounded-md hover:bg-bg-hover hover:text-fg"
      >
        {copied ? <Check className="size-md" /> : <Copy className="size-md" />}
      </button>
    </div>
  );
}

const QUIET_BUTTON =
  "inline-flex h-xl flex-none items-center rounded-sm border border-border px-xs text-fg-muted text-xs hover:border-border-strong hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent";

/**
 * 「恢复到此处」: two-step and inline, the same shape the 变更 panel's 「全部丢弃」
 * uses. Quiet until the message is hovered or the button itself is focused, so
 * the log reads as a log.
 *
 * Arming it asks the server what the restore would actually move, because the
 * whole point of the sentence is the number in it: 「任务动过的 N 个文件」. A span
 * the server cannot reduce to a file list says so instead of quietly rolling the
 * user's own work back with it.
 */
function RestoreAction({
  live,
  forward,
  onPreview,
  onRestore,
}: {
  live: boolean;
  /** The message is already dimmed, so this moves the tree forward to it rather than back. */
  forward: boolean;
  onPreview: () => Promise<CheckpointPreview>;
  onRestore: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const [preview, setPreview] = useState<CheckpointPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    onPreview().then(
      (next) => {
        if (!cancelled) setPreview(next);
      },
      (failure: unknown) => {
        if (!cancelled) setPreviewError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `armed` alone: `onPreview` is rebuilt on every
    // render of the log, while the message it asks about is fixed for this
    // component, so opening the confirm is the only thing worth re-asking on.
  }, [armed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!armed) {
    return (
      <div className="mt-2xs flex justify-end">
        <button
          type="button"
          disabled={live}
          {...(live ? { title: LIVE_REASON } : {})}
          onClick={() => setArmed(true)}
          className={cn(
            QUIET_BUTTON,
            "opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          恢复到此处
        </button>
      </div>
    );
  }

  return (
    <div className="mt-xs flex flex-col gap-2xs border-border border-t pt-xs">
      <p className="m-0 text-fg-muted text-xs">
        {previewError != null
          ? previewError
          : preview == null
            ? "正在算要动哪些文件…"
            : preview.whole
              ? `把工作目录${forward ? "恢复到这条消息发出之前" : "退回到这条消息发出之前"}？这一段里有没记下结束状态的回合，只能整个目录一起回退：你自己改的文件也会被还原。`
              : `会还原任务动过的 ${preview.files} 个文件；你自己改的其它文件不动。任务动过、你又手改过的文件会被覆盖。`}
      </p>
      <div className="flex items-center gap-2xs">
        <button
          type="button"
          disabled={live || (preview == null && previewError == null)}
          {...(live ? { title: LIVE_REASON } : {})}
          onClick={() => {
            setArmed(false);
            onRestore();
          }}
          className={cn(QUIET_BUTTON, "border-border-strong text-fg")}
        >
          {forward ? "确认前进到这里" : "确认恢复"}
        </button>
        <button type="button" onClick={() => setArmed(false)} className={QUIET_BUTTON}>
          取消
        </button>
      </div>
    </div>
  );
}

/** `查看 N 步 ▸` — a finished turn's process, collapsed. No timings available. */
function Fold({ run, actions, allowlist }: { run: Run; actions: TurnActions; allowlist: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-chat-inset">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-row-tool items-center gap-xs text-fg-muted hover:text-fg"
      >
        <span>共 {run.blocks.length} 步</span>
        <ChevronDown className={cn("size-md text-fg-faint transition-transform duration-[var(--duration-fast)]", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-xs flex flex-col gap-xs">
          {run.blocks.map((block) => (
            <BlockView key={block.key} block={block} actions={actions} allowlist={allowlist} running={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockView({
  block,
  actions,
  allowlist,
  running,
}: { block: Block; actions: TurnActions; allowlist: readonly string[]; running: boolean }): ReactNode {
  if (block.kind === "reasoning") {
    return (
      <Reasoning className="mb-0" defaultOpen={false} isStreaming={block.part.state === "streaming"}>
        {/* No duration rides on the part, so the label stays generic. */}
        <ReasoningTrigger
          className="text-fg-muted text-md hover:text-fg"
          getThinkingMessage={(isStreaming) => <span>{isStreaming ? "思考中…" : "思考"}</span>}
        />
        <ReasoningContent className="mt-2xs border-border border-l pl-md text-fg-faint text-sm">
          {block.part.text}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (block.kind === "text") {
    return (
      <div className="text-md leading-chat">
        <MessageResponse className="text-md leading-chat">{block.part.text}</MessageResponse>
      </div>
    );
  }

  const part = block.part;
  if (isOpenApproval(part) && part.state === "approval-requested") {
    return (
      <ApprovalCard
        part={part}
        id={approvalAnchor(part.toolCallId)}
        allowlist={allowlist}
        onRespond={(approved) => actions.respondToApproval(part.approval.id, approved)}
        onAlwaysAllow={(entries) => actions.alwaysAllow(part.approval.id, entries)}
      />
    );
  }

  if (isOpenQuestion(part)) {
    return (
      <QuestionCard
        id={questionAnchor(part.toolCallId)}
        input={part.input as AskUserQuestionsInput}
        onSubmit={(output) => actions.answerQuestions(part.toolCallId, output)}
      />
    );
  }

  if (getToolName(part) === "askUserQuestions") {
    return (
      <div className="flex min-h-row-tool items-center gap-xs text-fg-muted">
        <span className="flex-none">提问</span>
        <span className="min-w-0 truncate text-fg-faint">已回答</span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-xs">
      <div className="min-w-0 flex-1">
        <ToolRow part={part} onOpenFile={actions.openFile} />
      </div>
      {running && (
        <span className="flex h-row-tool flex-none items-center">
          <Spinner />
        </span>
      )}
    </div>
  );
}
