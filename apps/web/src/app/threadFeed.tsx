import { memo, useSyncExternalStore, type ComponentProps } from "react";
import type { UIMessage } from "ai";
import { RightPane, type RightTab } from "@/features/rightpane/RightPane";
import type { QueueItem } from "@/features/worklog/queue";

const sameQueue = (a: readonly QueueItem[], b: readonly QueueItem[]): boolean =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index];
    return other != null && item.kind === other.kind && item.anchor === other.anchor && item.label === other.label && item.mono === other.mono;
  });

/**
 * What the task on screen shows that the rest of the shell reads: its messages
 * (the right pane's 终端, 计划 and 工具 tabs) and its 待处理 queue (the pane's
 * count and the badge on its toggle).
 *
 * They change with every streamed chunk — twenty times a second — so they live
 * here and not in the shell's state: a `useState` at the top would re-render the
 * sidebar, the columns and everything else on each of them. Whoever needs one
 * subscribes to that one, and only it renders.
 */
export class ThreadFeed {
  private messages: UIMessage[] = [];
  private queue: QueueItem[] = [];
  private questions = 0;
  private readonly listeners = new Set<() => void>();

  setMessages = (next: UIMessage[]): void => {
    if (next === this.messages) return;
    this.messages = next;
    this.emit();
  };

  /** The queue is rebuilt from the messages on every chunk and is almost never different; an equal one changes nothing. */
  setQueue = (next: QueueItem[]): void => {
    if (sameQueue(this.queue, next)) return;
    this.queue = next;
    this.questions = next.filter((item) => item.kind === "question").length;
    this.emit();
  };

  getMessages = (): UIMessage[] => this.messages;
  getQueue = (): QueueItem[] => this.queue;
  /** How many of the queue are questions — the part of the toggle's badge the task record does not carry. */
  getQuestions = (): number => this.questions;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** These tabs do not show the messages, so they are left alone while the messages stream; any other tab (or one added later) does read them. */
const QUIET_TABS: readonly RightTab[] = ["home", "queue", "changes", "files"];
export const tabReadsMessages = (tab: RightTab): boolean => !QUIET_TABS.includes(tab);
const NO_MESSAGES: UIMessage[] = [];
const noMessages = (): UIMessage[] => NO_MESSAGES;

/**
 * `RightPane`, fed from the thread feed. The pane is not rendered for every
 * chunk any more: it hears about the messages only while a tab that shows them
 * (终端, 计划, 工具) is open, and about the queue when the queue itself changes.
 */
export const FedRightPane = memo(function FedRightPane({ feed, ...pane }: Omit<ComponentProps<typeof RightPane>, "messages" | "queue"> & { feed: ThreadFeed }) {
  const messages = useSyncExternalStore(feed.subscribe, tabReadsMessages(pane.tab) ? feed.getMessages : noMessages);
  const queue = useSyncExternalStore(feed.subscribe, feed.getQueue);
  return <RightPane {...pane} messages={messages} queue={queue} />;
});
