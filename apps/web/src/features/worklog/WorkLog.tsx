import { useMemo } from "react";
import type { UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import type { ThreadSummary } from "@/lib/types";
import { Turn, type TurnActions } from "./Turn";
import { buildTurns } from "./turns";

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
}: {
  messages: UIMessage[];
  thread: ThreadSummary;
  live: boolean;
  error: string | undefined;
  actions: TurnActions;
}) {
  const turns = useMemo(() => buildTurns(messages), [messages]);

  return (
    <Conversation className="min-h-0 flex-1">
      <ConversationContent className="mx-auto flex w-full max-w-log-max flex-col gap-0 px-md pb-2xl">
        {turns.map((turn, index) => (
          <Turn key={turn.key} turn={turn} isLast={index === turns.length - 1} live={live} actions={actions} />
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
