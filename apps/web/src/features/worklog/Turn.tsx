import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { LIVE_REASON, type AskUserQuestionsInput, type AskUserQuestionsOutput, type ThreadMessageMetadata } from "@/lib/types";
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
  /** 恢复到此处: put the files back to the snapshot taken before this message ran. */
  restoreCheckpoint: (messageId: string) => void;
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
  mainCheckout,
  actions,
  allowlist,
}: {
  turn: TurnModel;
  isLast: boolean;
  live: boolean;
  /** The task edits the project's own checkout, so a restore also undoes the user's edits. */
  mainCheckout: boolean;
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
    <section className="flex flex-col gap-block-gap pb-xl">
      {turn.user != null && (
        <div
          ref={ref}
          className={cn(
            "group rounded-lg border border-border bg-bg-elevated px-md py-sm",
            isLast && "sticky top-0 z-2",
            pinned && "border-b-border-strong shadow-sm",
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
          {checkpoint != null && (
            <RestoreAction
              live={live}
              mainCheckout={mainCheckout}
              onRestore={() => actions.restoreCheckpoint(turn.user!.id)}
            />
          )}
        </div>
      )}

      {runsOf(turn.blocks).map((run) =>
        run.kind === "foldable" && folded ? (
          <Fold key={run.key} run={run} actions={actions} allowlist={allowlist} />
        ) : (
          <div key={run.key} className="flex flex-col gap-2xs">
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
    </section>
  );
}

const QUIET_BUTTON =
  "inline-flex h-xl flex-none items-center rounded-sm border border-border px-xs text-fg-muted text-xs hover:border-border-strong hover:bg-bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-transparent";

/**
 * 「恢复到此处」: two-step and inline, the same shape the 变更 panel's 「全部丢弃」
 * uses. Quiet until the message is hovered or the button itself is focused, so
 * the log reads as a log.
 */
function RestoreAction({ live, mainCheckout, onRestore }: { live: boolean; mainCheckout: boolean; onRestore: () => void }) {
  const [armed, setArmed] = useState(false);

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
        把工作目录恢复到这条消息发出之前的状态？之后的文件改动会被撤掉，对话保留。
        {mainCheckout && "包括你自己在这之后改的文件。"}
      </p>
      <div className="flex items-center gap-2xs">
        <button
          type="button"
          disabled={live}
          {...(live ? { title: LIVE_REASON } : {})}
          onClick={() => {
            setArmed(false);
            onRestore();
          }}
          className={cn(QUIET_BUTTON, "border-border-strong text-fg")}
        >
          确认恢复
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
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-row-tool items-center gap-2xs rounded-sm px-2xs text-fg-faint text-sm hover:bg-bg-hover hover:text-fg-muted"
      >
        <span className={cn("text-2xs transition-transform duration-[var(--duration-fast)]", open && "rotate-90")}>▸</span>
        <span>查看 {run.blocks.length} 步</span>
      </button>
      {open && (
        <div className="mt-2xs flex flex-col gap-3xs border-border border-l pl-sm">
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
          className="text-fg-faint hover:text-fg-muted"
          getThinkingMessage={(isStreaming) => <span className="text-sm">{isStreaming ? "思考中…" : "思考"}</span>}
        />
        <ReasoningContent className="mt-2xs border-border border-l pl-md text-fg-faint text-sm">
          {block.part.text}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (block.kind === "text") {
    return (
      <div className="text-body">
        <MessageResponse>{block.part.text}</MessageResponse>
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
      <div className="flex h-row-tool items-center gap-xs px-2xs text-fg-muted text-sm">
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
