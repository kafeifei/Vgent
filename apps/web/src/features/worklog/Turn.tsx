import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { Check, ChevronDown, Copy, FileText, Send, Split } from "lucide-react";
import { UrlFigure } from "@/components/Figure";
import { RichMarkdown, TurnDrawingProvider } from "@/components/RichMarkdown";
import { type AskUserQuestionsInput, type AskUserQuestionsOutput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { completedCompactionRequest, isCompactionMarker, isCompactionRequest } from "@/lib/compaction";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Spinner, ToolRow } from "./ToolRow";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { TurnOutputs } from "./TurnOutputs";
import { processItemsOf, processSectionsOf, splitReply, stepCount, thoughtText, type ProcessItem, type RowBlock } from "./activity";
import { exploreCounts, exploreLabel } from "./explore";
import { isToolStreaming, type ToolPart } from "./toolMeta";
import type { Block, Turn as TurnModel } from "./turns";
import { formatTokens } from "@/features/composer/contextUsage";
import { approvalAnchor, isOpenApproval, isOpenQuestion, questionAnchor, turnEndOf } from "./turns";

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
  sendSteer?: (messageId: string, interrupt: boolean) => Promise<unknown> | void;
  /** 上下文已压缩: the summary that marker carries, in the right pane. */
  openSummary?: (messageId: string) => void;
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
  afterUser,
  preparing = false,
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
  /** Rows that belong between the message and the work — the worktree setup under the first one. */
  afterUser?: ReactNode;
  /** The worktree is still being made ready: its rows are what is live, so there is no 「思考中…」 yet. */
  preparing?: boolean;
}) {
  const { ref, pinned } = usePinned(isLast);
  // The reply, its actions and the output cards wait until the turn has settled.
  const settled = !(isLast && live);
  // While it runs the whole turn is process; once it settles the trailing text is the reply.
  const { process, reply } = settled ? splitReply(turn.blocks) : { process: turn.blocks, reply: [] };
  const sections = processSectionsOf(process);
  // A thought at the very end of a live turn is the one still going.
  const thinkingKey = !settled && turn.blocks.at(-1)?.kind === "reasoning" ? turn.blocks.at(-1)!.key : undefined;
  const compactRequest = isCompactionRequest(turn.user);
  const compactEvent = turn.blocks.some((block) => block.kind === "compaction");
  // How the turn ended when it did not simply finish. The last turn's error is
  // the log's own banner; every other ending is said here, under its turn.
  const ended = turn.user == null ? undefined : turnEndOf(turn.user);
  // 压缩 left a summary here: one line, the summary itself in the right pane.
  // An older build's summary came with a reply, which says nothing either.
  if (isCompactionMarker(turn.user)) {
    const id = turn.user!.id;
    return (
      <section className="pb-xl">
        <button
          type="button"
          onClick={() => actions.openSummary?.(id)}
          className="px-chat-inset text-fg-muted text-xs hover:text-fg"
        >
          上下文已压缩
        </button>
      </section>
    );
  }
  return (
    <TurnDrawingProvider drawings={drawings}>
    <section className={cn("flex flex-col gap-block-gap pb-xl text-md leading-chat", dimmed && "opacity-45")}>
      {compactRequest && !compactEvent && (
        <div className="px-chat-inset text-fg-muted text-xs" aria-live="polite">
          {completedCompactionRequest(turn.user) ? "上下文已压缩"
            : ended != null ? (ended.status === "error" ? "上下文压缩失败" : "上下文压缩已中断")
            : !settled ? <Shimmer>正在压缩上下文…</Shimmer>
            : "压缩结束，未确认结果"}
        </div>
      )}
      {turn.user != null && !compactRequest && (
        <div
          ref={ref}
          className={cn(
            "group rounded-xl border border-border bg-bg-elevated px-chat-inset py-sm shadow-xs",
            isLast && "sticky top-0 z-2",
            pinned && "shadow-sm",
          )}
        >
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
            part.type === "text" ? (
              <p key={index} className="m-0 whitespace-pre-wrap">
                {part.text}
              </p>
            ) : null,
          )}
        </div>
      )}
      {afterUser}

      {sections.map((section) => {
        if (section.kind !== "activity") return (
          <div key={section.key} className="px-chat-inset">
            <BlockView block={section.block} actions={actions} allowlist={allowlist} />
          </div>
        );
        const items = processItemsOf(section.blocks);
        const steps = stepCount(section.blocks);
        return settled && steps > 0 ? (
          <div key={section.key} className="px-chat-inset">
            <Fold steps={steps}>
              <ProcessList items={items} actions={actions} allowlist={allowlist} thinkingKey={thinkingKey} />
            </Fold>
          </div>
        ) : (
          <div key={section.key} className="flex flex-col gap-block-gap px-chat-inset">
            <ProcessList items={items} actions={actions} allowlist={allowlist} thinkingKey={thinkingKey} />
          </div>
        );
      })}
      {reply.map((block) => (
        <div key={block.key} className="px-chat-inset">
          <BlockView block={block as RowBlock} actions={actions} allowlist={allowlist} />
        </div>
      ))}
      {/* Until the first block lands there is nothing else on screen to say the turn is alive. */}
      {!compactRequest && !settled && !preparing && turn.blocks.length === 0 && (
        <div className="px-chat-inset text-fg-muted">
          <Shimmer>思考中…</Shimmer>
        </div>
      )}
      {!compactRequest && settled && turn.answered && turn.blocks.length === 0 && ended == null && <p className="m-0 px-chat-inset text-fg-faint">这一轮模型没有返回内容</p>}
      {settled && ended != null && !(isLast && ended.status === "error") && (
        <p className={cn("m-0 px-chat-inset whitespace-pre-wrap break-words text-sm", ended.status === "error" ? "text-danger" : "text-fg-faint")}>
          {ended.status === "error" ? `出错了 · ${ended.reason}` : ended.reason}
        </p>
      )}
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
        ) : "tools" in item ? (
          <ToolGroup key={item.key} tools={item.tools} kind={item.kind} actions={actions} />
        ) : (
          <BlockView key={item.key} block={item.block} actions={actions} allowlist={allowlist} />
        ),
      )}
    </>
  );
}

/** 「工作了 N 步」: one finished stretch of work, closed by default. */
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
  const bodyRef = useRef<HTMLDivElement>(null);
  // Capped box; while the thought is still coming, keep its newest lines in view.
  useEffect(() => {
    const body = bodyRef.current;
    if (open && streaming && body != null) body.scrollTop = body.scrollHeight;
  }, [open, streaming, text]);
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
        <div
          ref={bodyRef}
          className="mb-2xs max-h-[calc(var(--spacing-3xl)*4)] overflow-y-auto border-border border-l pl-md text-fg-faint text-sm"
        >
          <RichMarkdown className="text-sm">{text}</RichMarkdown>
        </div>
      )}
    </div>
  );
}

/** Consecutive tools of one category, with the original calls behind a summary. */
function ToolGroup({ tools, kind, actions }: { tools: Extract<ProcessItem, { tools: unknown }>["tools"]; kind: "explore" | "commands"; actions: TurnActions }) {
  const [open, setOpen] = useState(false);
  const busy = tools.some((block) => isToolStreaming(block.part));
  const label = kind === "commands" ? `执行 ${tools.length} 条命令` : exploreLabel(exploreCounts(tools));
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/explore flex min-h-row-tool w-full items-center gap-xs text-left text-fg-muted text-md leading-chat hover:text-fg"
      >
        {busy && <Spinner label="运行中" />}
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
    return <SteerMessage block={block} actions={actions} />;
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

/** A submitted steer looks like any other user message; only available actions reveal its state. */
function SteerMessage({ block, actions }: { block: Extract<Block, { kind: "steer" }>; actions: TurnActions }) {
  const [sending, setSending] = useState(false);
  const active = useRef(false);
  const label = block.interrupt ? "立即打断并发送" : "立即发送";
  return (
    <div className="group/steer relative -mx-chat-inset rounded-xl border border-border bg-bg-elevated px-chat-inset py-sm shadow-xs" data-steer-id={block.messageId}>
      <p className="m-0 whitespace-pre-wrap">{block.text}</p>
      {block.pending && block.messageId && actions.sendSteer && (
        <div className="absolute -top-3 right-xs opacity-0 transition-opacity group-hover/steer:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button type="button" aria-label={label} disabled={sending || block.busy}
            onClick={() => {
              if (active.current || block.busy) return;
              active.current = true; setSending(true);
              void Promise.resolve(actions.sendSteer!(block.messageId!, !!block.interrupt)).finally(() => { active.current = false; setSending(false); });
            }}
            className="inline-flex items-center gap-3xs rounded-md border border-border-strong bg-bg-elevated px-xs py-3xs text-fg-muted text-xs shadow-xs hover:bg-bg-hover hover:text-fg disabled:opacity-50">
            <Send className="size-sm" />{sending || block.busy ? "正在发送…" : label}
          </button>
        </div>
      )}
    </div>
  );
}
