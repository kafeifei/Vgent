import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToolName } from "ai";
import { MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import type { AskUserQuestionsInput, AskUserQuestionsOutput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Spinner, ToolRow } from "./ToolRow";
import type { Block, Run, Turn as TurnModel } from "./turns";
import { approvalAnchor, isOpenApproval, isOpenQuestion, questionAnchor, runsOf } from "./turns";

export interface TurnActions {
  respondToApproval: (approvalId: string, approved: boolean) => void;
  /** Approve this call and add its tool to the task's allowlist. */
  alwaysAllow: (approvalId: string, toolName: string) => void;
  answerQuestions: (toolCallId: string, output: AskUserQuestionsOutput) => void;
  openFile: (file: string) => void;
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
  actions,
}: {
  turn: TurnModel;
  isLast: boolean;
  live: boolean;
  actions: TurnActions;
}) {
  const { ref, pinned } = usePinned(isLast);
  // A finished turn folds its process blocks away; the running one stays open.
  const folded = !(isLast && live);

  return (
    <section className="flex flex-col gap-block-gap pb-xl">
      {turn.user != null && (
        <div
          ref={ref}
          className={cn(
            "rounded-lg border border-border bg-bg-elevated px-md py-sm",
            isLast && "sticky top-0 z-2",
            pinned && "border-b-border-strong shadow-sm",
          )}
        >
          {turn.user.parts.map((part, index) =>
            part.type === "text" ? (
              <p key={index} className="m-0 whitespace-pre-wrap">
                {part.text}
              </p>
            ) : null,
          )}
        </div>
      )}

      {runsOf(turn.blocks).map((run) =>
        run.kind === "foldable" && folded ? (
          <Fold key={run.key} run={run} actions={actions} />
        ) : (
          <div key={run.key} className="flex flex-col gap-2xs">
            {run.blocks.map((block, index) => (
              <BlockView
                key={block.key}
                block={block}
                actions={actions}
                running={live && isLast && index === run.blocks.length - 1}
              />
            ))}
          </div>
        ),
      )}
    </section>
  );
}

/** `查看 N 步 ▸` — a finished turn's process, collapsed. No timings available. */
function Fold({ run, actions }: { run: Run; actions: TurnActions }) {
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
            <BlockView key={block.key} block={block} actions={actions} running={false} />
          ))}
        </div>
      )}
    </div>
  );
}

function BlockView({ block, actions, running }: { block: Block; actions: TurnActions; running: boolean }): ReactNode {
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
        onRespond={(approved) => actions.respondToApproval(part.approval.id, approved)}
        onAlwaysAllow={(toolName) => actions.alwaysAllow(part.approval.id, toolName)}
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
