import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isToolUIPart, type UIMessage } from "ai";
import { ConflictError, NotFoundError } from "../errors.js";
import { repairMessageUsage } from "../message-usage.js";
import type {
  ApplyUndoRecord,
  ChangeStats,
  EngineId,
  HarnessState,
  Logger,
  QueuedMessage,
  ThreadMode,
  ThreadOutcome,
  ThreadPullRequest,
  ThreadRecord,
  ThreadForkOrigin,
  ThreadRestorePoint,
  ThreadStatus,
  ThreadSummary,
  ThreadTransition,
  ThreadWorkspace,
} from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

/** The placeholder a thread carries until its first user message names it. */
export const DEFAULT_THREAD_TITLE = "新任务";

interface ThreadIndexFile {
  version: 1;
  threads: ThreadSummary[];
}

/**
 * Marks a thread file's name as a pre-compact snapshot, not a record: an older
 * build's 压缩 replaced the history and kept the old one beside it, as
 * `<id>.pre-compact.<ts>.json`. None are written any more; the ones on disk
 * are skipped by the index and removed with their thread.
 */
const PRE_COMPACT_INFIX = ".pre-compact.";

export interface CreateThreadInput {
  projectId: string;
  title?: string;
  engine: EngineId;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  contextWindow?: number;
  /** 模式 of the first turn. Omitted (or `agent`) leaves the field off the record. */
  mode?: ThreadMode;
  workspaceState?: ThreadRecord["workspaceState"];
  /** 分叉: the history the task starts with, and where it was cut from. */
  messages?: UIMessage[];
  forkedFrom?: ThreadForkOrigin;
}

export type ThreadPatch = Partial<{
  consumeQueueIds: string[];
  /** Atomic recovery claim; rejects if the task was changed while startup awaited I/O. */
  consumeRestartRecovery: string;
  restartRecovery: string | undefined;
  taskState: ThreadRecord["taskState"];
  title: string;
  /** Only ever changed on a thread with no messages; the route enforces that. */
  engine: EngineId;
  model: string | undefined;
  reasoningEffort: string | undefined;
  serviceTier: string | undefined;
  contextWindow: number | undefined;
  /** `undefined` (or `agent`) clears it back to 直接动手. */
  mode: ThreadMode | undefined;
  status: ThreadStatus;
  error: string | undefined;
  /** 未读. `false` is 已读, which is the absence of the field. */
  unread: boolean | undefined;
  /** Deferred worktree creation state; undefined once ready. */
  workspaceState: ThreadRecord["workspaceState"] | undefined;
  /** Attached right after the worktree is created, cleared when it is removed. */
  workspace: ThreadWorkspace | undefined;
  /** 任务基线 of a main-checkout task: set on its first turn, moved forward by 提交. */
  baselineCommit: string | undefined;
  /** 收口 result. `undefined` clears it, which a new turn does. */
  outcome: ThreadOutcome | undefined;
  /** The PR link. Deliberately *not* cleared by a new turn — an opened PR stays open. */
  pr: ThreadPullRequest | undefined;
  /** 撤销带回 record. `undefined` drops it: 归档 does, and so does the undo itself. */
  applyUndo: ApplyUndoRecord | undefined;
  /** 恢复后停在哪里. `undefined` means 最新 — what a new turn and 「回到最新」 both set. */
  restoredTo: ThreadRestorePoint | undefined;
  forkedFrom: ThreadForkOrigin | undefined;
  changeStats: ChangeStats | undefined;
  /** 排队的消息. An empty array clears it — the field is never stored empty. */
  queue: QueuedMessage[] | undefined;
  /** `undefined` un-archives. */
  archivedAt: string | undefined;
  /** 压缩中, or why the last one failed. `undefined` once it is over, or superseded. */
  compaction: ThreadRecord["compaction"] | undefined;
  /** 归档中 / 恢复中. `undefined` once the worktree side of it is done — or taken back. */
  transition: ThreadTransition | undefined;
  /** Goes with `transition: "archiving"`, and away once the move is done or taken back. */
  archivePreserveChanges: true | undefined;
  messages: UIMessage[];
}>;

export interface ThreadStore {
  list(): Promise<ThreadSummary[]>;
  get(id: string): Promise<ThreadRecord | undefined>;
  create(input: CreateThreadInput): Promise<ThreadRecord>;
  update(id: string, patch: ThreadPatch): Promise<ThreadRecord>;
  /**
   * Mid-turn message persist: writes only that thread's file, and neither
   * rewrites the index nor notifies subscribers. The run's final `update()`
   * does both.
   */
  saveMessages(id: string, messages: UIMessage[]): Promise<void>;
  remove(id: string): Promise<void>;
  saveHarnessState(id: string, state: HarnessState): Promise<void>;
  loadHarnessState(id: string): Promise<HarnessState | undefined>;
  subscribe(listener: () => void): () => void;
}

const isRecord = (value: unknown): value is ThreadRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ThreadRecord).id === "string" &&
  Array.isArray((value as ThreadRecord).messages);

const isIndexFile = (value: unknown): value is ThreadIndexFile =>
  typeof value === "object" && value !== null && Array.isArray((value as ThreadIndexFile).threads);

/**
 * Both payloads are optional: a file may carry the last finished turn's
 * `resumeFrom`, a suspended turn's `continueFrom`, both, or — right after a
 * suspended turn was given up on — neither. Only the session id is structural.
 */
const isHarnessState = (value: unknown): value is HarnessState =>
  typeof value === "object" && value !== null && typeof (value as HarnessState).sessionId === "string";

/** Approvals the UI still has to answer: tool parts parked in `approval-requested`. */
export function countPendingApprovals(messages: readonly UIMessage[]): number {
  let count = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") count += 1;
    }
  }
  return count;
}

export function summarize(record: ThreadRecord): ThreadSummary {
  // `applyUndo` is destructured only to keep it out of `rest`.
  const { messages, queue, applyUndo: _applyUndo, taskState: _taskState, ...rest } = record;
  return {
    ...rest,
    ...(queue ? { queue: queue.map(({ files, ...item }) => ({
      ...item,
      ...(files?.length ? { files: files.map(({ type, mediaType, filename }) => ({ type, mediaType, ...(filename === undefined ? {} : { filename }) })) } : {}),
    })) } : {}),
    messageCount: messages.length,
    pendingApprovals: countPendingApprovals(messages),
  };
}

/**
 * One file per thread plus a small index, under `<dataDir>/threads/`.
 * Every write to a given thread goes through that thread's own promise chain,
 * so a throttled mid-turn persist can never land after the final one.
 */
export function createThreadStore(dataDir: string, log: Logger = silentLogger): ThreadStore {
  const dir = join(dataDir, "threads");
  const indexPath = join(dir, "index.json");
  const recordPath = (id: string) => join(dir, `${id}.json`);
  const harnessPath = (id: string) => join(dir, `${id}.harness.json`);

  const listeners = new Set<() => void>();
  const chains = new Map<string, Promise<unknown>>();
  let index: ThreadSummary[] | undefined;
  let ready: Promise<void> | undefined;

  /** Serializes work per key; the chain never rejects, so one failure cannot poison the next call. */
  const serialize = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    chains.set(
      key,
      next.catch(() => {}),
    );
    return next;
  };

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        log.warn("线程变更监听器抛错", error);
      }
    }
  };

  const rebuildIndex = async (): Promise<ThreadSummary[]> => {
    const entries = await readdir(dir).catch(() => [] as string[]);
    const summaries: ThreadSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry === "index.json" || entry.endsWith(".harness.json") || entry.includes(PRE_COMPACT_INFIX))
        continue;
      const record = await readJsonOrQuarantine<ThreadRecord>(join(dir, entry), { validate: isRecord, log });
      if (record != null) summaries.push(summarize(record));
    }
    summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await writeJsonAtomic(indexPath, { version: 1, threads: summaries } satisfies ThreadIndexFile);
    return summaries;
  };

  const ensureReady = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = await readJsonOrQuarantine<ThreadIndexFile>(indexPath, { validate: isIndexFile, log });
      index = file?.threads ?? (await rebuildIndex());
    })();
    return ready;
  };

  const writeIndex = () =>
    serialize("\0index", async () => {
      await writeJsonAtomic(indexPath, { version: 1, threads: index ?? [] } satisfies ThreadIndexFile);
    });

  const putSummary = (summary: ThreadSummary) => {
    const current = index ?? [];
    const position = current.findIndex((entry) => entry.id === summary.id);
    if (position >= 0) current[position] = summary;
    else current.unshift(summary);
    index = current;
  };

  const readRecord = async (id: string) => {
    const record = await readJsonOrQuarantine<ThreadRecord>(recordPath(id), { validate: isRecord, log });
    // Immediately correct API reads; persist on the next normal write without
    // making a read race a live run or changing the task's activity timestamp.
    if (record != null) record.messages = repairMessageUsage(record.messages, record.engine);
    return record;
  };

  return {
    async list() {
      await ensureReady();
      return [...(index ?? [])];
    },

    async get(id) {
      await ensureReady();
      return readRecord(id);
    },

    async create(input) {
      await ensureReady();
      const now = new Date().toISOString();
      const record: ThreadRecord = {
        version: 1,
        id: randomUUID(),
        projectId: input.projectId,
        title: input.title?.trim() || DEFAULT_THREAD_TITLE,
        engine: input.engine,
        ...(input.model != null ? { model: input.model } : {}),
        ...(input.reasoningEffort != null ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.serviceTier != null ? { serviceTier: input.serviceTier } : {}),
        ...(input.contextWindow != null ? { contextWindow: input.contextWindow } : {}),
        ...(input.mode === "plan" ? { mode: "plan" as const } : {}),
        status: "idle",
        ...(input.workspaceState != null ? { workspaceState: input.workspaceState } : {}),
        createdAt: now,
        updatedAt: now,
        messages: repairMessageUsage(input.messages ?? [], input.engine),
        ...(input.forkedFrom != null ? { forkedFrom: input.forkedFrom } : {}),
      };
      await serialize(record.id, () => writeJsonAtomic(recordPath(record.id), record));
      putSummary(summarize(record));
      await writeIndex();
      notify();
      return record;
    },

    async update(id, patch) {
      await ensureReady();
      const updated = await serialize(id, async () => {
        const current = await readRecord(id);
        if (current == null) throw new NotFoundError(`线程不存在: ${id}`, "thread_not_found");
        if (patch.consumeRestartRecovery != null && (current.restartRecovery !== patch.consumeRestartRecovery ||
          current.status !== "interrupted" || current.archivedAt != null || current.transition != null ||
          current.workspace?.reclaimed === true || current.workspaceState != null || current.outcome != null)) {
          throw new ConflictError("任务状态已改变，取消自动继续", "recovery_superseded");
        }
        const next: ThreadRecord = {
          ...current,
          ...("title" in patch && patch.title != null ? { title: patch.title } : {}),
          ...("engine" in patch && patch.engine != null ? { engine: patch.engine } : {}),
          ...("status" in patch && patch.status != null ? { status: patch.status } : {}),
          ...("messages" in patch && patch.messages != null ? { messages: patch.messages } : {}),
          // Reading a task or reconciling cached Git stats is bookkeeping.
          // Neither should move the task in the activity-sorted sidebar.
          updatedAt: Object.keys(patch).every((key) => key === "unread" || key === "changeStats")
            ? current.updatedAt
            : new Date().toISOString(),
        };
        if (patch.consumeQueueIds) {
          const consumed = new Set(patch.consumeQueueIds);
          next.queue = (current.queue ?? []).filter((item) => !consumed.has(item.id));
          if (!next.queue.length) delete next.queue;
        }
        if ("restartRecovery" in patch) {
          if (patch.restartRecovery == null) delete next.restartRecovery;
          else next.restartRecovery = patch.restartRecovery;
        }
        // Explicit lifecycle changes cancel boot intent, even if later undone.
        if (patch.consumeRestartRecovery != null || patch.archivedAt != null || patch.transition != null ||
          patch.workspace?.reclaimed === true || patch.outcome != null) delete next.restartRecovery;
        if ("taskState" in patch) {
          if (patch.taskState == null) delete next.taskState;
          else next.taskState = patch.taskState;
        }
        // `exactOptionalPropertyTypes`: clearing an optional field means deleting it.
        if ("model" in patch) {
          if (patch.model == null) delete next.model;
          else next.model = patch.model;
        }
        if ("reasoningEffort" in patch) {
          if (patch.reasoningEffort == null) delete next.reasoningEffort;
          else next.reasoningEffort = patch.reasoningEffort;
        }
        if ("contextWindow" in patch) {
          if (patch.contextWindow == null) delete next.contextWindow;
          else next.contextWindow = patch.contextWindow;
        }
        if ("serviceTier" in patch) {
          if (patch.serviceTier == null) delete next.serviceTier;
          else next.serviceTier = patch.serviceTier;
        }
        // `agent` is the absence of a mode, so it is stored as one.
        if ("mode" in patch) {
          if (patch.mode !== "plan") delete next.mode;
          else next.mode = "plan";
        }
        if ("error" in patch) {
          if (patch.error == null) delete next.error;
          else next.error = patch.error;
        }
        // 已读 is the absence of a flag, so it is stored as one.
        if ("unread" in patch) {
          if (patch.unread !== true) delete next.unread;
          else next.unread = true;
        }
        if ("workspaceState" in patch) {
          if (patch.workspaceState == null) delete next.workspaceState;
          else next.workspaceState = patch.workspaceState;
        }
        if ("workspace" in patch) {
          if (patch.workspace == null) delete next.workspace;
          else next.workspace = patch.workspace;
        }
        if ("baselineCommit" in patch) {
          if (patch.baselineCommit == null) delete next.baselineCommit;
          else next.baselineCommit = patch.baselineCommit;
        }
        if ("outcome" in patch) {
          if (patch.outcome == null) delete next.outcome;
          else next.outcome = patch.outcome;
        }
        if ("pr" in patch) {
          if (patch.pr == null) delete next.pr;
          else next.pr = patch.pr;
        }
        if ("applyUndo" in patch) {
          if (patch.applyUndo == null) delete next.applyUndo;
          else next.applyUndo = patch.applyUndo;
        }
        if ("forkedFrom" in patch) {
          if (patch.forkedFrom == null) delete next.forkedFrom;
          else next.forkedFrom = patch.forkedFrom;
        }
        if ("restoredTo" in patch) {
          if (patch.restoredTo == null) delete next.restoredTo;
          else next.restoredTo = patch.restoredTo;
        }
        if ("changeStats" in patch) {
          if (patch.changeStats == null) delete next.changeStats;
          else next.changeStats = patch.changeStats;
        }
        // An empty queue is the absence of one, so it is stored as one.
        if ("queue" in patch) {
          if (patch.queue == null || patch.queue.length === 0) delete next.queue;
          else {
            const consumed = new Set(
              next.messages.flatMap((message) => [
                ...(message.role === "user" ? [message.id] : []),
                ...message.parts.flatMap((part) =>
                  part.type === "data-steer" && (part as { data?: { receipt?: boolean } }).data?.receipt !== true && typeof (part as { id?: unknown }).id === "string" ? [(part as { id: string }).id] : [],
                ),
              ]),
            );
            next.queue = patch.queue.filter((item) => !consumed.has(item.id));
            if (!next.queue.length) delete next.queue;
          }
        }
        if ("archivedAt" in patch) {
          if (patch.archivedAt == null) delete next.archivedAt;
          else next.archivedAt = patch.archivedAt;
        }
        if ("transition" in patch) {
          if (patch.transition == null) delete next.transition;
          else next.transition = patch.transition;
        }
        if ("compaction" in patch) {
          if (patch.compaction == null) delete next.compaction;
          else next.compaction = patch.compaction;
        }
        if ("archivePreserveChanges" in patch) {
          if (patch.archivePreserveChanges == null) delete next.archivePreserveChanges;
          else next.archivePreserveChanges = patch.archivePreserveChanges;
        }
        next.messages = repairMessageUsage(next.messages, next.engine);
        await writeJsonAtomic(recordPath(id), next);
        return next;
      });
      putSummary(summarize(updated));
      await writeIndex();
      notify();
      return updated;
    },

    async saveMessages(id, messages) {
      await ensureReady();
      await serialize(id, async () => {
        const current = await readRecord(id);
        if (current == null) return;
        await writeJsonAtomic(recordPath(id), { ...current, messages: repairMessageUsage(messages, current.engine), updatedAt: new Date().toISOString() } satisfies ThreadRecord);
      });
    },

    async remove(id) {
      await ensureReady();
      await serialize(id, async () => {
        await rm(recordPath(id), { force: true });
        await rm(harnessPath(id), { force: true });
        const entries = await readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          entries
            .filter((entry) => entry.startsWith(`${id}${PRE_COMPACT_INFIX}`))
            .map((entry) => rm(join(dir, entry), { force: true }).catch(() => {})),
        );
      });
      index = (index ?? []).filter((entry) => entry.id !== id);
      await writeIndex();
      notify();
    },

    async saveHarnessState(id, state) {
      await ensureReady();
      await serialize(`${id}\0harness`, () => writeJsonAtomic(harnessPath(id), state, { mode: 0o600 }));
    },

    async loadHarnessState(id) {
      await ensureReady();
      return readJsonOrQuarantine<HarnessState>(harnessPath(id), { validate: isHarnessState, log });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
