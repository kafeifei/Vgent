import type { FileUIPart, UIMessage } from "ai";
import { randomUUID } from "node:crypto";
import { decodeDataUrl } from "./attachments.js";
import { BadRequestError, ConflictError, NotFoundError, VgentServerError } from "./errors.js";
import { isDraftMediaType, MAX_DRAFT_ATTACHMENT_BYTES, MAX_DRAFT_ATTACHMENTS } from "./store/drafts.js";
import type { ThreadStore } from "./store/threads.js";
import type { QueuedMessage, ThreadRecord } from "./types.js";

/** How many messages one task may keep waiting. */
export const QUEUE_MAX_ITEMS = 20;

/** Cap on one queued message's text, independent of its files. */
export const QUEUE_ITEM_MAX_BYTES = 32 * 1024;
/** Decoded bytes per message; encoded URLs across the whole queue are also capped. */
export const QUEUE_FILES_MAX_BYTES = 20 * 1024 * 1024;
export const QUEUE_FILE_URLS_MAX_BYTES = 64 * 1024 * 1024;

const filesTooLarge = (message: string): never => {
  throw new VgentServerError({ message, status: 413, code: "queue_files_too_large" });
};

/** Persist self-contained data URLs, never ephemeral blob URLs or remote references. */
export function readQueueFiles(value: unknown): FileUIPart[] {
  if (value === undefined) return [];
  const invalid = (): never => { throw new BadRequestError("附件必须包含有效的文件名、类型和 data URL", "invalid_queue_files"); };
  if (!Array.isArray(value)) return invalid();
  if (value.length > MAX_DRAFT_ATTACHMENTS) filesTooLarge(`每条消息最多 ${MAX_DRAFT_ATTACHMENTS} 个附件`);
  let total = 0;
  return value.map((entry: unknown) => {
    if (entry == null || typeof entry !== "object") return invalid();
    const { type, mediaType, filename, url } = entry as Record<string, unknown>;
    if (type !== "file" || !isDraftMediaType(mediaType) || typeof mediaType !== "string" || typeof url !== "string") return invalid();
    if (filename !== undefined && (typeof filename !== "string" || filename.length > 255)) return invalid();
    // Reject oversized encodings before allocating a decoded buffer (percent encoding is at most 3x).
    if (url.length > MAX_DRAFT_ATTACHMENT_BYTES * 3 + 512) filesTooLarge("单个附件不能超过 10 MB");
    const prefix = `data:${mediaType}`;
    if (!url.startsWith(`${prefix},`) && !url.startsWith(`${prefix};base64,`)) return invalid();
    if (url.startsWith(`${prefix};base64,`)) {
      const payload = url.slice(prefix.length + 8);
      if (payload.length > Math.ceil(MAX_DRAFT_ATTACHMENT_BYTES / 3) * 4) filesTooLarge("单个附件不能超过 10 MB");
      if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return invalid();
    }
    let bytes: Uint8Array | undefined;
    try { bytes = decodeDataUrl(url); } catch { return invalid(); }
    if (bytes == null) return invalid();
    if (bytes.byteLength > MAX_DRAFT_ATTACHMENT_BYTES) filesTooLarge("单个附件不能超过 10 MB");
    total += bytes.byteLength;
    if (total > QUEUE_FILES_MAX_BYTES) filesTooLarge("每条排队消息的附件合计不能超过 20 MB");
    return { type: "file" as const, mediaType, url, ...(typeof filename === "string" ? { filename } : {}) };
  });
}

const fileUrlBytes = (files: readonly FileUIPart[]): number => files.reduce((sum, file) => sum + Buffer.byteLength(file.url, "utf8"), 0);
const assertQueueMode = (mode: "queue" | "steer", files: readonly FileUIPart[]): void => {
  if (mode === "steer" && files.length > 0) throw new BadRequestError("带附件的消息请排队到下一回合，不能转为引导", "queue_files_cannot_steer");
};

/** Blank text is valid only when the message still carries files. */
export function readQueueText(value: unknown, hasFiles = false): string {
  if (typeof value !== "string" || (!hasFiles && value.trim() === "")) throw new BadRequestError("text 必须是字符串；没有附件时不能为空", "invalid_queue_text");
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
  append(threadId: string, text: unknown, mode?: "queue" | "steer", files?: unknown): Promise<ThreadRecord>;
  edit(threadId: string, itemId: string, text: unknown): Promise<ThreadRecord>;
  remove(threadId: string, itemId: string): Promise<ThreadRecord>;
  reorder(threadId: string, ids: readonly string[]): Promise<ThreadRecord>;
  setMode(threadId: string, itemId: string, mode: "queue" | "steer"): Promise<ThreadRecord>;
  beginDelivery(threadId: string, itemId: string): Promise<QueuedMessage | undefined>;
  settleSteers(threadId: string, ids: readonly string[], interrupted: boolean): Promise<void>;
  reserveSend(threadId: string, itemId: string, reserved: boolean): Promise<void>;
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

    append: (threadId, value, mode = "queue", fileValue) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const files = readQueueFiles(fileValue);
        const text = readQueueText(value, files.length > 0);
        assertQueueMode(mode, files);
        const queue = thread.queue ?? [];
        if (queue.length >= QUEUE_MAX_ITEMS) {
          throw new BadRequestError(`排队最多 ${QUEUE_MAX_ITEMS} 条，先发出或删掉一些`, "queue_full");
        }
        if (queue.reduce((sum, item) => sum + fileUrlBytes(item.files ?? []), fileUrlBytes(files)) > QUEUE_FILE_URLS_MAX_BYTES) {
          filesTooLarge("排队附件总量已满，请先发出或删掉一些");
        }
        return write(threadId, [...queue, { id: randomUUID(), text, createdAt: new Date().toISOString(), mode, ...(files.length ? { files } : {}) }]);
      }),

    edit: (threadId, itemId, value) =>
      locked(threadId, async () => {
        const thread = await load(threadId);
        const queue = thread.queue ?? [];
        const target = queue.find((item) => item.id === itemId);
        if (!target) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        if (target.accepted || target.delivering || target.promoting)
          throw new ConflictError("引导已送达，不能再编辑", "steer_already_accepted");
        const text = readQueueText(value, (target.files?.length ?? 0) > 0);
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
        if (queue.some((item) => item.id === itemId && (item.accepted === true || item.delivering === true || item.promoting === true)))
          throw new ConflictError("引导已送达，不能直接删除", "steer_already_accepted");
        return write(
          threadId,
          queue.filter((item) => item.id !== itemId),
        );
      }),

    reorder: (threadId, ids) =>
      locked(threadId, async () => {
        const all = (await load(threadId)).queue ?? [];
        const queue = ids.length === all.length ? all : all.filter(item => item.mode !== "steer");
        if (ids.length !== queue.length || new Set(ids).size !== ids.length || ids.some((id) => !queue.some((item) => item.id === id))) {
          throw new BadRequestError("队列顺序与当前消息不一致，请刷新后重试", "queue_order_changed");
        }
        if (queue.some((item, index) => (item.accepted === true || item.delivering === true || item.promoting === true) && ids[index] !== item.id)) {
          throw new ConflictError("已送达的引导不能移动", "steer_already_accepted");
        }
        const byId = new Map(queue.map((item) => [item.id, item]));
        let position = 0;
        return write(
          threadId,
          all.map(item => queue.includes(item) ? byId.get(ids[position++]!)! : item),
        );
      }),

    setMode: (threadId, itemId, mode) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        const item = queue.find((entry) => entry.id === itemId);
        if (!item) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
        assertQueueMode(mode, item.files ?? []);
        if (item.accepted || item.delivering || item.promoting)
          throw new ConflictError("引导已送达", "steer_already_accepted");
        return write(
          threadId,
          queue.map((item) => (item.id === itemId ? { ...item, mode, accepted: false } : item)),
        );
      }),

    beginDelivery: (threadId, itemId) => locked(threadId, async () => {
      const queue = (await load(threadId)).queue ?? [];
      const item = queue.find(entry => entry.id === itemId);
      if (!item || item.mode !== "steer" || item.accepted || item.delivering || item.promoting || item.applied) return undefined;
      await write(threadId, queue.map(entry => entry.id === itemId ? { ...entry, delivering: true } : entry));
      return item;
    }),

    reserveSend: (threadId, itemId, reserved) => locked(threadId, async () => {
      const queue = (await load(threadId)).queue ?? [];
      const item = queue.find(entry => entry.id === itemId);
      if (!item) { if (reserved) throw new NotFoundError("这条消息不存在", "queue_item_not_found"); return; }
      if (reserved && (item.applied || item.promoting || item.delivering || item.claimed))
        throw new ConflictError("这条消息已开始处理或正在交付", "steer_already_applied");
      await write(threadId, queue.map(entry => entry.id === itemId ? { ...entry, promoting: reserved } : entry));
    }),

    settleSteers: (threadId, ids, interrupted) => locked(threadId, async () => {
      const queue = (await load(threadId)).queue ?? [];
      const selected = new Set(ids);
      await write(threadId, queue.flatMap(item => {
        if (!selected.has(item.id)) return [item];
        // The SDK can confirm application before the submit promise resolves.
        if (item.applied || (!interrupted && item.accepted)) return [];
        return [{ ...item, accepted: false, delivering: false }];
      }));
    }),

    markAccepted: (threadId, itemId, accepted) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (!queue.some((item) => item.id === itemId)) return;
        await write(
          threadId,
          queue.map((item) => (item.id === itemId ? { ...item, accepted: accepted || item.applied === true, delivering: false, applied: item.applied === true } : item)),
        );
      }),

    markApplied: (threadId, itemId) =>
      locked(threadId, async () => {
        const queue = (await load(threadId)).queue ?? [];
        if (queue.some((item) => item.id === itemId && item.mode === "steer")) {
          await write(
            threadId,
            queue.map((item) => (item.id === itemId ? { ...item, accepted: true, applied: true } : item)),
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
        const taken = queue.filter((item) => item.mode === "steer" && !item.accepted && !item.delivering && !item.promoting);
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
            ? queue.find((entry) => !entry.accepted && !entry.delivering && !entry.promoting && !entry.applied)
            : queue.find((entry) => entry.id === options.itemId && !entry.accepted && !entry.delivering && !entry.applied);
        if (item == null) return undefined;
        await write(
          threadId,
          options?.retain
            ? queue.map((entry) => (entry.id === item.id ? { ...entry, accepted: true, claimed: true, promoting: false } : entry))
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
