import type { UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.js";
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
  append(threadId: string, text: string, mode?: "queue" | "steer"): Promise<ThreadRecord>;
  edit(threadId: string, itemId: string, text: string): Promise<ThreadRecord>;
  remove(threadId: string, itemId: string): Promise<ThreadRecord>;
  reorder(threadId: string, ids: readonly string[]): Promise<ThreadRecord>;
  setMode(threadId: string, itemId: string, mode: "queue" | "steer"): Promise<ThreadRecord>;
  markAccepted(threadId: string, itemId: string, accepted: boolean): Promise<void>;
  markApplied(threadId: string, itemId: string): Promise<void>;
  /** Remove only the acknowledgements belonging to a completed turn. */
  removeAccepted(threadId: string, ids: readonly string[]): Promise<void>;
  /** Peek without a callback; with one, persist the transcript and consume steers in a single update. */
  takeSteers(threadId: string, record?: (items: QueuedMessage[]) => UIMessage[]): Promise<QueuedMessage[]>;
  /**
   * Lift one item out — the named one, or the head. `undefined` means there was
   * nothing to take, which is the normal answer for a dispatcher that lost a
   * race. Production dispatch uses `retain` to claim durably until turn start.
   * Callers already holding the lock pass `held` so it is not re-taken.
   */
  take(threadId: string, options?: { itemId?: string; held?: boolean; retain?: boolean }): Promise<QueuedMessage | undefined>;
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

    append: (threadId, text, mode = "queue") =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        if (queue.length >= QUEUE_MAX_ITEMS) {
          throw new BadRequestError(`排队最多 ${QUEUE_MAX_ITEMS} 条，先发出或删掉一些`, "queue_full");
        }
        return write(threadId, [...queue, { id: randomUUID(), text, createdAt: new Date().toISOString(), mode }]);
      }),

    edit: (threadId, itemId, text) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        if (!queue.some((item) => item.id === itemId)) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        if (queue.some((item) => item.id === itemId && item.accepted === true))
          throw new ConflictError("引导已送达，不能再编辑", "steer_already_accepted");
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
        if (queue.some((item) => item.id === itemId && item.accepted === true))
          throw new ConflictError("引导已送达，不能直接删除", "steer_already_accepted");
        return write(
          threadId,
          queue.filter((item) => item.id !== itemId),
        );
      }),

    reorder: (threadId, ids) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (ids.length !== queue.length || new Set(ids).size !== ids.length || ids.some((id) => !queue.some((item) => item.id === id))) {
          throw new BadRequestError("队列顺序与当前消息不一致，请刷新后重试", "queue_order_changed");
        }
        if (queue.some((item, index) => item.accepted === true && ids[index] !== item.id)) {
          throw new ConflictError("已送达的引导不能移动", "steer_already_accepted");
        }
        const byId = new Map(queue.map((item) => [item.id, item]));
        return write(
          threadId,
          ids.map((id) => byId.get(id)!),
        );
      }),

    setMode: (threadId, itemId, mode) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (!queue.some((item) => item.id === itemId)) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        if (queue.some((item) => item.id === itemId && item.accepted === true))
          throw new ConflictError("引导已送达", "steer_already_accepted");
        return write(
          threadId,
          queue.map((item) => (item.id === itemId ? { ...item, mode, accepted: false } : item)),
        );
      }),

    markAccepted: (threadId, itemId, accepted) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (!queue.some((item) => item.id === itemId)) return;
        await write(
          threadId,
          queue.map((item) => (item.id === itemId ? { ...item, accepted, applied: accepted && item.applied === true } : item)),
        );
      }),

    markApplied: (threadId, itemId) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (queue.some((item) => item.id === itemId && item.mode === "steer")) {
          await write(
            threadId,
            queue.map((item) => (item.id === itemId ? { ...item, applied: true } : item)),
          );
        }
      }),

    removeAccepted: (threadId, ids) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        const selected = new Set(ids);
        const remaining = queue.filter((item) => !selected.has(item.id) || item.accepted !== true);
        if (remaining.length !== queue.length) await write(threadId, remaining);
      }),

    takeSteers: (threadId, record) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        const taken = queue.filter((item) => item.mode === "steer" && item.accepted !== true);
        // With no transcript commit this is a peek: a crash cannot discard the input.
        if (taken.length > 0 && record)
          await threads.update(threadId, {
            messages: record(taken),
            queue: queue.filter((item) => !taken.includes(item)),
          });
        return taken;
      }),

    async take(threadId, options) {
      const work = async (): Promise<QueuedMessage | undefined> => {
        const thread = await threads.get(threadId).catch(() => undefined);
        const queue = thread?.queue ?? [];
        const item =
          options?.itemId == null
            ? queue.find((entry) => entry.accepted !== true)
            : queue.find((entry) => entry.id === options.itemId && entry.accepted !== true);
        if (item == null) return undefined;
        await write(
          threadId,
          options?.retain
            ? queue.map((entry) => (entry.id === item.id ? { ...entry, accepted: true, claimed: true } : entry))
            : queue.filter((entry) => entry.id !== item.id),
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
        if (queue.some((entry) => entry.id === item.id)) {
          await write(
            threadId,
            queue.map((entry) => (entry.id === item.id ? { ...item, accepted: false } : entry)),
          );
          return;
        }
        await write(threadId, [item, ...queue]);
      };
      if (options?.held === true) await work();
      else await locked(threadId, work);
    },
  };
}
