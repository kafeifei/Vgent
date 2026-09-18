import { randomUUID } from "node:crypto";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { ThreadStore } from "./store/threads.js";
import type { QueuedMessage, ThreadRecord } from "./types.js";

/** How many messages one task may keep waiting. */
export const QUEUE_MAX_ITEMS = 20;

/** Cap on one queued message, so a runaway paste cannot bloat the thread file. */
export const QUEUE_ITEM_MAX_BYTES = 32 * 1024;

/**
 * One queued message's text from a request body. Blank is a 400 rather than a
 * silently dropped item: the composer only ever posts what the user typed.
 */
export function readQueueText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequestError("text 必须是非空字符串", "invalid_queue_text");
  if (Buffer.byteLength(value, "utf8") > QUEUE_ITEM_MAX_BYTES) {
    throw new BadRequestError(`排队消息超过 ${QUEUE_ITEM_MAX_BYTES / 1024} KB`, "queue_item_too_large");
  }
  return value;
}

/**
 * 排队 storage for one task, on top of the thread record.
 *
 * Every mutation runs under a per-thread lock, because all of them are
 * read-modify-write cycles and two of the writers are not HTTP requests: the
 * dispatcher that starts the next turn by itself, and the 「发送」 route. Taking
 * an item out and starting its turn is what the lock really protects — an item
 * that is on its way to the engine must not still be editable.
 */
export interface QueueStore {
  /** Runs `work` with exclusive access to this thread's queue. */
  locked<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  append(threadId: string, text: string): Promise<ThreadRecord>;
  edit(threadId: string, itemId: string, text: string): Promise<ThreadRecord>;
  remove(threadId: string, itemId: string): Promise<ThreadRecord>;
  /**
   * Lift one item out — the named one, or the head. `undefined` means there was
   * nothing to take, which is the normal answer for a dispatcher that lost a
   * race. Callers already holding the lock pass `held` so it is not re-taken.
   */
  take(threadId: string, options?: { itemId?: string; held?: boolean }): Promise<QueuedMessage | undefined>;
  /** Put a taken item back at the head, for a turn that could not be started. */
  putBack(threadId: string, item: QueuedMessage, options?: { held?: boolean }): Promise<void>;
}

export function createQueueStore(threads: ThreadStore): QueueStore {
  /** One promise chain per thread; it never rejects, so one failure cannot poison the next call. */
  const chains = new Map<string, Promise<unknown>>();

  const locked = <T>(threadId: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(threadId) ?? Promise.resolve();
    const next = previous.then(work, work);
    chains.set(
      threadId,
      next.catch(() => {}),
    );
    return next;
  };

  const load = async (threadId: string): Promise<ThreadRecord> => {
    const thread = await threads.get(threadId);
    if (thread == null) throw new NotFoundError(`线程不存在: ${threadId}`, "thread_not_found");
    return thread;
  };

  const write = (threadId: string, queue: QueuedMessage[]): Promise<ThreadRecord> => threads.update(threadId, { queue });

  return {
    locked,

    append: (threadId, text) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        if (queue.length >= QUEUE_MAX_ITEMS) {
          throw new BadRequestError(`排队最多 ${QUEUE_MAX_ITEMS} 条，先发出或删掉一些`, "queue_full");
        }
        return write(threadId, [...queue, { id: randomUUID(), text, createdAt: new Date().toISOString() }]);
      }),

    edit: (threadId, itemId, text) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        if (!queue.some((item) => item.id === itemId)) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        return write(
          threadId,
          queue.map((item) => (item.id === itemId ? { ...item, text } : item)),
        );
      }),

    remove: (threadId, itemId) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        if (!queue.some((item) => item.id === itemId)) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        return write(
          threadId,
          queue.filter((item) => item.id !== itemId),
        );
      }),

    async take(threadId, options) {
      const work = async (): Promise<QueuedMessage | undefined> => {
        const thread = await threads.get(threadId).catch(() => undefined);
        const queue = thread?.queue ?? [];
        const item = options?.itemId == null ? queue[0] : queue.find((entry) => entry.id === options.itemId);
        if (item == null) return undefined;
        await write(
          threadId,
          queue.filter((entry) => entry.id !== item.id),
        );
        return item;
      };
      return options?.held === true ? work() : locked(threadId, work);
    },

    async putBack(threadId, item, options) {
      const work = async (): Promise<void> => {
        const thread = await threads.get(threadId).catch(() => undefined);
        if (thread == null) return;
        const queue = thread.queue ?? [];
        if (queue.some((entry) => entry.id === item.id)) return;
        await write(threadId, [item, ...queue]);
      };
      if (options?.held === true) await work();
      else await locked(threadId, work);
    },
  };
}
