import { Fragment, useMemo } from "react";
import type { UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import type { ThreadSummary } from "@/lib/types";
import { RestoredBar } from "./RestoredBar";
import { Turn, type TurnActions } from "./Turn";
import { writtenDrawings } from "./outputs";
import { buildTurns } from "./turns";

const NO_DRAWINGS: ReadonlyMap<string, string> = new Map();

/**
 * The scroll container is AI Elements' `Conversation`: it brings the
 * follow-the-bottom behaviour and the scroll-to-bottom button that replace the
 * prototype's hand-rolled 「有新内容」 float.
 */
export function WorkLog({
  messages,
  thread,
  live,
  error,
  actions,
  allowlist,
}: {
  messages: UIMessage[];
  thread: ThreadSummary;
  live: boolean;
  error: string | undefined;
  actions: TurnActions;
  /** The global 「一直允许」 list; only the approval card reads it. */
  allowlist: readonly string[];
}) {
  const turns = useMemo(() => buildTurns(messages), [messages]);
  // What each turn left in the SVGs the task writes, carried forward turn to turn (see `writtenDrawings`).
  const drawings = useMemo(() => {
    let held: ReadonlyMap<string, string> = new Map();
    return turns.map((turn) => (held = writtenDrawings(turn.blocks, held)));
  }, [turns]);
  /**
   * 恢复后停在哪里: the first turn whose files are no longer on disk. It and
   * everything under it is dimmed, with the bar drawn in at that exact point —
   * the messages themselves are never deleted, here or on the server.
   */
  const restoredAt = thread.restoredTo?.messageId;
  const restoredIndex = restoredAt == null ? -1 : turns.findIndex((turn) => turn.user?.id === restoredAt);

  return (
    // A task opens at its end and stays pinned there without a show: the element's
    // default glides down from the top on every open, and again each time a
    // picture or an output card lands and the log grows.
    <Conversation initial="instant" resize="instant" className="min-h-0 flex-1">
      <ConversationContent className="mx-auto flex w-full max-w-[calc(var(--spacing-log-max)+2*var(--spacing-md))] flex-col gap-0 px-md pt-2xs pb-2xl">
        {turns.map((turn, index) => (
          <Fragment key={turn.key}>
            {index === restoredIndex && <RestoredBar live={live} onLatest={actions.restoreLatest} />}
            <Turn
              turn={turn}
              isLast={index === turns.length - 1}
              live={live}
              dimmed={restoredIndex >= 0 && index >= restoredIndex}
              actions={actions}
              allowlist={allowlist}
              drawings={drawings[index] ?? NO_DRAWINGS}
            />
          </Fragment>
        ))}

        {error != null && (
          <div className="mb-xl rounded-md border border-danger bg-danger-bg px-md py-sm text-danger text-sm">
            <span className="font-semibold">出错了</span>
            <span className="ml-xs whitespace-pre-wrap break-words">{error}</span>
          </div>
        )}

        {turns.length === 0 && (
          <p className="py-2xl text-center text-fg-faint text-sm">
            {thread.status === "idle" ? "还没有内容，在下面写下第一个目标。" : "等待引擎…"}
          </p>
        )}
      </ConversationContent>
      <ConversationScrollButton className="rounded-full border border-border-strong bg-bg-elevated text-fg shadow-md hover:bg-bg-active" />
    </Conversation>
  );
}
