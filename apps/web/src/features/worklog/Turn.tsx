import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { Check, ChevronDown, Copy, FileText, Split } from "lucide-react";
import { RichMarkdown } from "@/components/RichMarkdown";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { type AskUserQuestionsInput, type AskUserQuestionsOutput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Spinner, ToolRow } from "./ToolRow";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { TurnOutputs } from "./TurnOutputs";
import type { Block, Run, Turn as TurnModel } from "./turns";
import { formatTokens } from "@/features/composer/contextUsage";
import { approvalAnchor, compactedOf, isOpenApproval, isOpenQuestion, questionAnchor, runsOf } from "./turns";

export interface TurnActions {
  respondToApproval: (approvalId: string, approved: boolean) => void;
  /** Approve this call and add these entries to the global allowlist. */
  alwaysAllow: (approvalId: string, entries: string[]) => void;
  answerQuestions: (toolCallId: string, output: AskUserQuestionsOutput) => void;
  openFile: (file: string) => void;
  /** 分叉: a new task with the conversation up to the end of the turn this user message started. */
  fork: (messageId: string) => void;
  /** 回到最新, for a task an older build left standing at an earlier checkpoint. */
  restoreLatest: () => void;
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
  actions,
  allowlist,
  drawings,
}: {
  turn: TurnModel;
  isLast: boolean;
  live: boolean;
  /** This turn sits at or after the restore point: it happened, but its files are not on disk. */
  dimmed: boolean;
  actions: TurnActions;
  allowlist: readonly string[];
  /** Every SVG the task has written, as it stood when this turn ended. */
  drawings: ReadonlyMap<string, string>;
}) {
  const { ref, pinned } = usePinned(isLast);
  // A finished turn folds its process blocks away; the running one stays open.
  const folded = !(isLast && live);
  // A `/compact` summary is an ordinary user message apart from this marker.
  const compacted = turn.user == null ? undefined : compactedOf(turn.user);
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
          {/* 附件 first, the way they sat above the text in the composer. */}
          {turn.user.parts.some((part) => part.type === "file") && (
            <div className="mb-xs flex flex-wrap gap-xs">
              {turn.user.parts.map((part, index) =>
                part.type !== "file" ? null : part.mediaType.startsWith("image/") ? (
                  <a key={index} href={part.url} target="_blank" rel="noreferrer" title={part.filename}>
                    <img
                      src={part.url}
                      alt={part.filename ?? "图片"}
                      className="max-h-[calc(var(--spacing-3xl)*3)] max-w-full rounded-lg border border-border object-contain"
                    />
                  </a>
                ) : (
                  <span
                    key={index}
                    title={part.filename}
                    className="inline-flex h-xl max-w-[32ch] items-center gap-xs rounded-md border border-border bg-bg-inset px-sm text-fg-secondary text-sm"
                  >
                    <FileText className="size-md flex-none text-fg-muted" />
                    <span className="min-w-0 truncate">{part.filename ?? part.mediaType}</span>
                  </span>
                ),
              )}
            </div>
          )}
          {turn.user.parts.map((part, index) =>
            // The `/compact` a harness engine was sent is the marker above, not a message.
            part.type === "text" && !(compacted != null && part.text === "/compact") ? (
              <p key={index} className="m-0 whitespace-pre-wrap">
                {part.text}
              </p>
            ) : null,
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
      {/* Until the first block lands there is nothing else on screen to say the turn is alive. */}
      {!folded && turn.blocks.length === 0 && (
        <div className="px-chat-inset text-fg-muted">
          <Shimmer>思考中…</Shimmer>
        </div>
      )}
      {folded && turn.answered && turn.blocks.length === 0 && <p className="m-0 px-chat-inset text-fg-faint">这一轮模型没有返回内容</p>}
      {folded && <TurnOutputs blocks={turn.blocks} drawings={drawings} />}
      {folded && turn.blocks.length > 0 && <ReplyActions turn={turn} {...(turn.user != null ? { onFork: () => actions.fork(turn.user!.id) } : {})} />}
    </section>
  );
}

/** The quiet row under a finished reply. 复制 takes the reply's text, not the process above it. */
function ReplyActions({ turn, onFork }: { turn: TurnModel; onFork?: () => void }) {
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
      {/* One click and no confirm: it opens a new task and leaves this one exactly as it is. */}
      {onFork != null && (
        <button
          type="button"
          aria-label="从这里分叉"
          title="从这里分叉出一个新任务"
          onClick={onFork}
          className="grid size-xl place-items-center rounded-md hover:bg-bg-hover hover:text-fg"
        >
          {/* Cursor's glyph: one stem branching upward. */}
          <Split className="-rotate-90 size-md" />
        </button>
      )}
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

  if (block.kind === "compaction") {
    const { tokensBefore, tokensAfter } = block.data;
    const tokens = tokensBefore != null && tokensAfter != null ? `（${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)}）` : "";
    return <p className="m-0 text-fg-muted text-xs">{block.data.trigger === "manual" ? "上下文已压缩" : "上下文快满，已自动压缩"}{tokens}</p>;
  }

  if (block.kind === "steer") {
    // The same box a turn's opening message gets — it is the same speaker —
    // pulled out to the log's full width like that one is.
    return (
      <div className="-mx-chat-inset rounded-xl border border-border bg-bg-elevated px-chat-inset py-sm shadow-xs">
        <p className="m-0 whitespace-pre-wrap">{block.text}</p>
      </div>
    );
  }

  if (block.kind === "text") {
    return (
      <div className="text-md leading-chat">
        <RichMarkdown className="text-md leading-chat">{block.part.text}</RichMarkdown>
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
