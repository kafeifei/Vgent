import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { Check, ChevronDown, Copy, FileText, Split } from "lucide-react";
import { UrlFigure } from "@/components/Figure";
import { RichMarkdown, TurnDrawingProvider } from "@/components/RichMarkdown";
import { type AskUserQuestionsInput, type AskUserQuestionsOutput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Spinner, ToolRow } from "./ToolRow";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { TurnOutputs } from "./TurnOutputs";
import { processItemsOf, splitReply, stepCount, thoughtText, type ProcessItem, type RowBlock } from "./activity";
import { exploreCounts, exploreLabel } from "./explore";
import { isToolStreaming, type ToolPart } from "./toolMeta";
import type { Block, Turn as TurnModel } from "./turns";
import { formatTokens } from "@/features/composer/contextUsage";
import { approvalAnchor, compactedOf, isOpenApproval, isOpenQuestion, questionAnchor } from "./turns";

export interface TurnActions {
  respondToApproval: (approvalId: string, approved: boolean) => void;
  /** Approve this call and add these entries to the global allowlist. */
  alwaysAllow: (approvalId: string, entries: string[]) => void;
  answerQuestions: (toolCallId: string, output: AskUserQuestionsOutput) => void;
  openFile: (file: string) => void;
  /** A click on a tool row: the call opened where it belongs (终端, 文件, or a detail view). */
  inspect: (part: ToolPart) => void;
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
  // The reply, its actions and the output cards wait until the turn has settled.
  const settled = !(isLast && live);
  // While it runs the whole turn is process; once it settles the trailing text is the reply.
  const { process, reply } = settled ? splitReply(turn.blocks) : { process: turn.blocks, reply: [] };
  const items = processItemsOf(process);
  const steps = stepCount(process);
  // A thought at the very end of a live turn is the one still going.
  const thinkingKey = !settled && turn.blocks.at(-1)?.kind === "reasoning" ? turn.blocks.at(-1)!.key : undefined;
  // A `/compact` summary is an ordinary user message apart from this marker.
  const compacted = turn.user == null ? undefined : compactedOf(turn.user);
  return (
    <TurnDrawingProvider drawings={drawings}>
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
                  <UrlFigure
                    key={index}
                    src={part.url}
                    alt={part.filename ?? "图片"}
                    wrapperClassName="my-0"
                    thumbnailClassName="max-h-[calc(var(--spacing-3xl)*3)] max-w-full rounded-lg border border-border object-contain shadow-none"
                  />
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

      {items.length > 0 &&
        (settled && steps > 0 ? (
          <div className="px-chat-inset">
            <Fold steps={steps}>
              <ProcessList items={items} actions={actions} allowlist={allowlist} thinkingKey={thinkingKey} />
            </Fold>
          </div>
        ) : (
          <div className="flex flex-col gap-block-gap px-chat-inset">
            <ProcessList items={items} actions={actions} allowlist={allowlist} thinkingKey={thinkingKey} />
          </div>
        ))}
      {reply.map((block) => (
        <div key={block.key} className="px-chat-inset">
          <BlockView block={block as RowBlock} actions={actions} allowlist={allowlist} />
        </div>
      ))}
      {/* Until the first block lands there is nothing else on screen to say the turn is alive. */}
      {!settled && turn.blocks.length === 0 && (
        <div className="px-chat-inset text-fg-muted">
          <Shimmer>思考中…</Shimmer>
        </div>
      )}
      {settled && turn.answered && turn.blocks.length === 0 && <p className="m-0 px-chat-inset text-fg-faint">这一轮模型没有返回内容</p>}
      {settled && <TurnOutputs blocks={turn.blocks} drawings={drawings} />}
      {settled && turn.blocks.length > 0 && <ReplyActions turn={turn} {...(turn.user != null ? { onFork: () => actions.fork(turn.user!.id) } : {})} />}
    </section>
    </TurnDrawingProvider>
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

/** The process, one row per item, in the order it happened. */
function ProcessList({
  items,
  actions,
  allowlist,
  thinkingKey,
}: { items: ProcessItem[]; actions: TurnActions; allowlist: readonly string[]; thinkingKey: string | undefined }) {
  return (
    <>
      {items.map((item) =>
        item.kind === "thought" ? (
          <ThoughtRow key={item.key} parts={item.parts} thinking={item.parts.some((block) => block.key === thinkingKey)} />
        ) : item.kind === "explore" ? (
          <ExploreGroup key={item.key} tools={item.tools} actions={actions} />
        ) : (
          <BlockView key={item.key} block={item.block} actions={actions} allowlist={allowlist} />
        ),
      )}
    </>
  );
}

/** 「工作了 N 步」: a finished turn's process, closed by default, the same list behind it. */
function Fold({ steps, children }: { steps: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/fold flex min-h-row-tool w-full items-center gap-xs text-left text-fg-muted text-md leading-chat hover:text-fg"
      >
        <span>工作了 {steps} 步</span>
        <ChevronDown className={cn("size-md flex-none text-fg-faint transition-transform duration-[var(--duration-fast)]", !open && "-rotate-90")} />
      </button>
      {open && <div className="flex flex-col gap-block-gap border-border border-l pl-md">{children}</div>}
    </div>
  );
}

/** 「思考」: the reasoning of one stretch, one row; 「思考中…」 while it is the live edge. */
function ThoughtRow({ parts, thinking }: { parts: Extract<ProcessItem, { kind: "thought" }>["parts"]; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  const streaming = thinking || parts.at(-1)?.part.state === "streaming";
  const text = thoughtText(parts);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        disabled={text === ""}
        onClick={() => setOpen((value) => !value)}
        className="group/thought flex min-h-row-tool w-full items-center gap-xs text-left text-fg-muted text-md leading-chat hover:text-fg"
      >
        {streaming ? <Shimmer as="span">思考中…</Shimmer> : <span>思考</span>}
        {text !== "" && (
          <ChevronDown
            className={cn(
              "size-md flex-none text-fg-faint opacity-0 transition-transform duration-[var(--duration-fast)] group-hover/thought:opacity-100",
              open ? "opacity-100" : "-rotate-90",
            )}
          />
        )}
      </button>
      {open && text !== "" && (
        <div className="mb-2xs border-border border-l pl-md text-fg-faint text-sm">
          <RichMarkdown className="text-sm">{text}</RichMarkdown>
        </div>
      )}
    </div>
  );
}

/** Two or more consecutive looks on one line with counts; the calls are behind it. A running one spins the line. */
function ExploreGroup({ tools, actions }: { tools: Extract<ProcessItem, { kind: "explore" }>["tools"]; actions: TurnActions }) {
  const [open, setOpen] = useState(false);
  const busy = tools.some((block) => isToolStreaming(block.part));
  const label = exploreLabel(exploreCounts(tools));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/explore flex min-h-row-tool w-full items-center gap-xs text-left text-fg-muted text-md leading-chat hover:text-fg"
      >
        {busy && <Spinner />}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown
          className={cn(
            "size-md flex-none text-fg-faint opacity-0 transition-transform duration-[var(--duration-fast)] group-hover/explore:opacity-100",
            open ? "opacity-100" : "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="pl-md">
          {tools.map((block) => (
            <ToolRow key={block.key} part={block.part} onOpenFile={actions.openFile} onInspect={actions.inspect} />
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
}: { block: RowBlock; actions: TurnActions; allowlist: readonly string[] }): ReactNode {
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

  return <ToolRow part={part} onOpenFile={actions.openFile} onInspect={actions.inspect} />;
}
