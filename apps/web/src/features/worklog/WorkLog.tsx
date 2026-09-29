import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { ArrowDownIcon } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ThreadSummary } from "@/lib/types";
import { RestoredBar } from "./RestoredBar";
import { Turn, type TurnActions } from "./Turn";
import { writtenDrawings } from "./outputs";
import { buildTurns } from "./turns";
import { WorktreeSetup, worktreePhases } from "./WorktreeSetup";

const NO_DRAWINGS: ReadonlyMap<string, string> = new Map();

/** Still counts as the end, so a click that only nudges the log stays pinned. */
const END_SLOP = 80;

/** Where the reader left each task: following the end, or a scroll offset. */
const places = new Map<string, { follow: boolean; top: number }>();

/**
 * The log owns its scrollport. AI Elements' `Conversation` writes `scrollTop`
 * from a later frame, so the first paint is the top of the task and the jump
 * to the end is visible. Setting it here happens after this element's ref is
 * attached and before the browser paints.
 *
 * The pad under the last line is a fixed `pb-3xl`, the same in every task.
 * A task opens where that task was left: the end, if new output was being
 * followed, otherwise the offset from the last real scroll. Writes we make
 * ourselves are not recorded — a programmatic scroll used to be stored as the
 * place, so the next click landed in neither spot. The arrow jumps back to
 * the end and following resumes.
 */
export function WorkLog({
  messages,
  thread,
  live,
  error,
  actions,
  allowlist,
  client,
}: {
  messages: UIMessage[];
  thread: ThreadSummary;
  live: boolean;
  error: string | undefined;
  actions: TurnActions;
  /** The global 「一直允许」 list; only the approval card reads it. */
  allowlist: readonly string[];
  client: Pick<ApiClient, "getSetupLog">;
}) {
  const turns = useMemo(() => buildTurns(messages, thread.queue, live), [messages, thread.queue, live]);
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
  const preparing = thread.workspaceState === "creating" || thread.workspace?.setup?.status === "running";
  // 创建 worktree / 运行 setup 脚本 sit under the first message, the turn they
  // held back; with no message on screen yet they stand on their own.
  const setup = worktreePhases(thread).length > 0 ? <WorktreeSetup thread={thread} client={client} /> : null;
  const setupAfterFirst = turns[0]?.user != null;

  const remembered = places.get(thread.id);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(remembered?.follow ?? true);
  const savedTop = useRef(remembered?.top ?? 0);
  const placed = useRef(false);
  /** The `scrollTop` we just wrote. The scroll event it causes is not the reader moving. */
  const ownScroll = useRef<number | null>(null);
  const [atEnd, setAtEnd] = useState(remembered?.follow ?? true);

  const writeScroll = (scroller: HTMLDivElement, top: number) => {
    scroller.scrollTop = top;
    ownScroll.current = scroller.scrollTop;
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller == null) return;
    if (followRef.current) writeScroll(scroller, scroller.scrollHeight);
    else if (!placed.current) writeScroll(scroller, Math.min(savedTop.current, scroller.scrollHeight));
    placed.current = true;
  });

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (scroller == null) return;
    if (ownScroll.current != null && Math.abs(scroller.scrollTop - ownScroll.current) <= 1) {
      ownScroll.current = null;
      return;
    }
    ownScroll.current = null;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const near = gap <= END_SLOP;
    followRef.current = near;
    places.set(thread.id, { follow: near, top: scroller.scrollTop });
    setAtEnd(near);
  };

  const jumpToEnd = () => {
    const scroller = scrollerRef.current;
    followRef.current = true;
    places.set(thread.id, { follow: true, top: scroller?.scrollTop ?? 0 });
    setAtEnd(true);
    if (scroller == null) return;
    writeScroll(scroller, scroller.scrollHeight);
    places.set(thread.id, { follow: true, top: scroller.scrollTop });
  };

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto [overflow-anchor:none]"
      >
        <div className="mx-auto flex w-full max-w-[calc(var(--spacing-log-max)+2*var(--spacing-md))] flex-col gap-0 px-md pt-2xs pb-3xl">
          {setup != null && !setupAfterFirst && <div className="pt-sm pb-xl text-md leading-chat">{setup}</div>}
          {turns.map((turn, index) => (
            <div key={turn.key}>
              {index === restoredIndex && <RestoredBar live={live} onLatest={actions.restoreLatest} />}
              <Turn
                turn={turn}
                {...(index === 0 && setupAfterFirst && setup != null ? { afterUser: setup } : {})}
                isLast={index === turns.length - 1}
                live={live}
                dimmed={restoredIndex >= 0 && index >= restoredIndex}
                actions={actions}
                allowlist={allowlist}
                drawings={drawings[index] ?? NO_DRAWINGS}
              />
            </div>
          ))}

          {error != null && thread.workspaceState !== "failed" && (
            <div className="mb-xl rounded-md border border-danger bg-danger-bg px-md py-sm text-danger text-sm">
              <span className="font-semibold">出错了</span>
              <span className="ml-xs whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}

          {turns.length === 0 && !preparing && thread.workspaceState !== "failed" && (
            <p className="py-2xl text-center text-fg-faint text-sm">
              {thread.archivedAt != null ? "还没有内容。" : thread.status === "idle" ? "还没有内容，在下面写下第一个目标。" : "等待引擎…"}
            </p>
          )}
        </div>
      </div>
      {!atEnd && (
        <button
          type="button"
          aria-label="回到底部"
          onClick={jumpToEnd}
          className={cn(
            "absolute bottom-4 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full",
            "border border-border-strong bg-bg-elevated text-fg shadow-md hover:bg-bg-active",
          )}
        >
          <ArrowDownIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
