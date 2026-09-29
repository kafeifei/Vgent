import { classifyFailure } from "@vgent/engine";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getHarnessErrorMessage } from "@ai-sdk/harness/agent";
import {
  convertToModelMessages,
  isToolUIPart,
  readUIMessageStream,
  safeValidateUIMessages,
  toUIMessageStream,
  type DynamicToolUIPart,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
  type ToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { prepareAttachments } from "./attachments.js";
import { createAfterCheckpoint, createCheckpoint, deleteCheckpoints, pinBaseline } from "./checkpoints.js";
import type { ChunkHub } from "./chunk-hub.js";
import { createChunkHub } from "./chunk-hub.js";
import { BadRequestError, ConflictError, NotFoundError, TurnResumeFailedError, VgentServerError } from "./errors.js";
import { effectivePermission } from "./engines/capabilities.js";
import type { EngineContext, EngineRegistry, EngineRunner } from "./engines/registry.js";
import { statelessEngines } from "./engines/registry.js";
import type { QueueStore } from "./queue.js";
import { forkNote } from "./fork.js";
import { projectOfThread } from "./no-project.js";
import { restoreNote } from "./restore.js";
import { compactionChunk, isCompactionPart } from "./compaction.js";
import { expandSteers, steerChunk, withoutPromotedSteers } from "./steer.js";
import type { ProjectStore } from "./store/projects.js";
import type { SettingsStore } from "./store/settings.js";
import { DEFAULT_THREAD_TITLE, type ThreadStore, type ThreadPatch } from "./store/threads.js";
import type {
  ChangeStats,
  EngineId,
  Logger,
  MessageCheckpoint,
  QueuedMessage,
  ThreadMessageMetadata,
  ThreadRecord,
  ThreadStatus,
  TurnEnd,
  UsageInfo,
} from "./types.js";
import { silentLogger } from "./types.js";
import { whenSetupSettled } from "./worktree-setup.js";

/** Mid-turn persists are at least this far apart; the final one always lands. */
const PERSIST_INTERVAL_MS = 1000;

/** How long `stop()` waits for a run to wind down before it forces the slot open. */
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** Cap on the raw error text persisted to a thread record. */
const RAW_ERROR_TEXT_MAX_LEN = 2000;

/** A 每回合快照 slower than this is worth a line in the log, but never skipped. */
const SLOW_CHECKPOINT_MS = 5_000;

/**
 * 未读: what a turn settling into one of these means is「它自己停下了，你还没
 * 看过」—— done, failed, or parked on the human. `interrupted` is not among
 * them: the user pressed 停止, so there is nothing to call them back for.
 */
const UNREAD_STATUSES: readonly ThreadStatus[] = ["idle", "error", "awaiting-approval", "awaiting-input"];

/** Whether a turn that ended in `status` leaves the task 未读. */
export const marksUnread = (status: ThreadStatus): boolean => UNREAD_STATUSES.includes(status);

/**
 * The unmasked error text for a thread record. `getHarnessErrorMessage`
 * (used as `toUIMessageStream`'s `onError`) produces a client-safe string —
 * right for the SSE stream, but the thread record is local single-user data,
 * so it keeps the real message for debugging and later display.
 */
export function rawErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // The SDK wraps a dropped connection as "Failed to process successful
  // response", which says nothing; what happened is at the bottom of the
  // `cause` chain ("other side closed", "terminated").
  let root: unknown = error;
  for (let depth = 0; depth < 5 && root instanceof Error && root.cause != null; depth += 1) root = root.cause;
  const why = root !== error && root instanceof Error ? root.message.trim() : "";
  const full = why !== "" && !text.includes(why) ? `${text.trim()}（${why}）` : text.trim();
  return full.slice(0, RAW_ERROR_TEXT_MAX_LEN);
}

/**
 * v7 `LanguageModelUsage` → the flat `UsageInfo` a thread message carries.
 *
 * `inputTokens` is taken as reported: in v7 it is the full prompt of that call,
 * with `inputTokenDetails.cacheReadTokens` being the cached *part* of it, not an
 * extra amount on top. Every field is dropped when the provider left it
 * undefined, so `exactOptionalPropertyTypes` holds and nothing lands in the
 * thread file as an explicit null.
 */
function toUsageInfo(usage: LanguageModelUsage): UsageInfo {
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  return {
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens } : {}),
    ...(cached != null ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
  };
}

/** Two `UsageInfo`s added field by field; a field neither side has stays absent. */
function addUsageInfo(a: UsageInfo, b: UsageInfo): UsageInfo {
  const sum: UsageInfo = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (a[key] != null || b[key] != null) sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return sum;
}

/** Whether an engine counted anything at all — a Codex bridge's `finish` can carry all zeros. */
const counted = (usage: UsageInfo): boolean => (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0;

/** Cap on an auto-derived thread title. */
export const AUTO_TITLE_MAX_LEN = 60;

/**
 * The first line of the first user message, for a thread still carrying the
 * default title. Returns undefined when there is nothing usable to name it
 * with, so the placeholder stays.
 */
export function deriveThreadTitle(messages: readonly UIMessage[]): string | undefined {
  const first = messages.find((message) => message.role === "user");
  if (first == null) return undefined;
  const text = first.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  const line = text
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  if (line == null || line.length === 0) return undefined;
  return line.slice(0, AUTO_TITLE_MAX_LEN);
}

export const RESTART_INTERRUPT_TEXT = "服务已重启";
export const RESTART_PENDING_TOOL_TEXT = "服务已重启，请重新发送";
/** A turn that was frozen for the restart but could not be picked up again. */
export const RESUME_FAILED_TEXT = "服务重启后未能恢复这一轮，请重新发送";
export const STOP_INTERRUPT_TEXT = "已停止";
export const ABANDONED_TURN_TEXT = "该轮已被新的提问取代";
/** A call the engine started announcing but never ran — the turn ended first. */
export const UNEXECUTED_TOOL_TEXT = "未执行";

/**
 * `messages` with `end` recorded on the last user message — the one whose turn
 * just ended — or, with `undefined`, cleared from it. See `TurnEnd`.
 */
export function withTurnEnd(messages: readonly UIMessage[], end: TurnEnd | undefined): UIMessage[] {
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index < 0) return [...messages];
  const message = messages[index]!;
  const { turnEnd: previous, ...rest } = (message.metadata as ThreadMessageMetadata | undefined) ?? {};
  if (end == null && previous == null) return [...messages];
  const next = [...messages];
  next[index] = { ...message, metadata: end == null ? rest : { ...rest, turnEnd: end } };
  return next;
}

export function withRunRecord(messages: readonly UIMessage[], run: NonNullable<ThreadMessageMetadata["run"]>): UIMessage[] {
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index < 0) return [...messages];
  return messages.map((message, i) => (i === index ? { ...message, metadata: { ...(message.metadata as object), run } } : message));
}

type AnyToolUIPart = ToolUIPart | DynamicToolUIPart;

/** A half-streamed tool part lifted out of a continuation seed, and where it sat. */
interface DroppedToolPart {
  /** Its index in the *stripped* part list, so putting it back restores its place. */
  index: number;
  part: AnyToolUIPart;
}

interface LiveRun {
  hub: ChunkHub;
  abort: AbortController;
  done: Promise<void>;
  stopped: boolean;
  /** Set while the engine is streaming, so a 插话 has someone to go to. */
  runner?: EngineRunner;
  acceptedSteers: Set<string>;
  deliveringSteers: Set<string>;
  steerCalls: Set<Promise<void>>;
  completedNormally: boolean;
  retired?: boolean;
  recordSteer?: (item: QueuedMessage) => Promise<void>;
  flush?: () => Promise<void>;
}

/** A runner kept alive between requests because its turn is waiting on the human. */
type RunHooks = Pick<EngineContext, "takeSteers" | "steerApplied" | "saveTaskState" | "saveHarnessState">;

interface ParkedEngine {
  hooks: { current: RunHooks };
  runner: EngineRunner;
  /** Its engine's `statelessTurns`: whether the pending answer outlives this process. */
  stateless: boolean;
}

export interface RunManager {
  start(threadId: string, uiMessages: unknown): Promise<ChunkHub>;
  /**
   * 排队「发送」: take one queued message out and run it as a turn, right now.
   * The item goes back to the head of the queue if the turn could not start.
   */
  sendQueued(threadId: string, itemId: string): Promise<void>;
  /**
   * Run the head of a thread's queue if — and only if — the thread is idle,
   * unarchived and has one. Used at boot; after a turn it schedules itself.
   */
  dispatchQueue(threadId: string): Promise<void>;
  /**
   * Push one already-persisted steer toward the active runtime. `false` means
   * it has not accepted it yet; the durable item remains available for a later
   * input boundary or the next turn.
   */
  steer(threadId: string, text: string, itemId: string): Promise<boolean>;
  stop(threadId: string): Promise<void>;
  subscribe(threadId: string, signal?: AbortSignal): ReadableStream<UIMessageChunk> | undefined;
  isRunning(threadId: string): boolean;
  /** Stop every live run and destroy every parked engine. For shutdown. */
  stopAll(): Promise<void>;
}

export function createRunManager(options: {
  threads: ThreadStore;
  projects: ProjectStore;
  /** 运行模式 and its allowlist, read per turn so a change lands on the next message. */
  settings: SettingsStore;
  registry: EngineRegistry;
  dataDir: string;
  log?: Logger;
  stopTimeoutMs?: number;
  /** Wait for a deferred worktree before setup or any turn can start. */
  whenWorkspaceReady?: (id: string) => Promise<void>;
  /**
   * The task's diff against its baseline, recomputed for the thread record when
   * a turn ends. Injected because the git plumbing belongs to the app, not here;
   * a rejection is logged and the previous value kept — it never fails a turn.
   */
  changeStats?: (thread: ThreadRecord) => Promise<ChangeStats | undefined>;
  /**
   * Where a finished 计划 turn's answer goes. Injected because the plan store
   * belongs to the app, not here; a rejection is logged and the turn stands.
   */
  savePlan?: (threadId: string, content: string) => Promise<void>;
  /**
   * How a turn ended, for whoever keeps the engines' runtimes: a fresh upgrade
   * counts as good once a turn ends well on it, and is rolled back when one
   * dies before producing anything. A stop by the user says nothing either way
   * and is not reported. Never awaited into the turn: a rejection is logged.
   */
  onTurnSettled?: (info: { engine: EngineId; ok: boolean; produced: boolean }) => Promise<void>;
  /**
   * 排队. Absent leaves the manager without a dispatcher — nothing is ever sent
   * by itself, which is what a test that only drives turns by hand wants.
   */
  queue?: QueueStore;
}): RunManager {
  const { threads, projects, settings, registry, dataDir } = options;

  /** Fire-and-forget: the runtime keeper's bookkeeping must never hold up or fail a turn. */
  const reportTurn = (engine: EngineId, ok: boolean, assistant: UIMessage | undefined): void => {
    const produced = (assistant?.parts.length ?? 0) > 0;
    void options
      .onTurnSettled?.({ engine, ok, produced })
      .catch((error: unknown) => (options.log ?? silentLogger).warn(`回报 ${engine} 的运行结果失败`, error));
  };
  const log = options.log ?? silentLogger;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const runs = new Map<string, LiveRun>();
  const owners = new Map<string, LiveRun>();
  const writing = new Map<string, Promise<void>>();
  /** Serialize only turn startup, not the turn itself or queue writes. */
  const starting = new Map<string, Promise<void>>();
  const dispatching = new Map<string, Promise<void>>();
  const locked = async <T>(locks: Map<string, Promise<void>>, threadId: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(threadId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(threadId, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (locks.get(threadId) === current) locks.delete(threadId);
    }
  };
  /** Submit one durable steer at most once while this run is live. */
  const deliverSteer = async (threadId: string, text: string, itemId: string): Promise<boolean> => {
    const run = runs.get(threadId);
    const runner = run?.runner;
    if (run == null || run.stopped || run.hub.closed || runner?.steer == null || run.deliveringSteers.has(itemId)) return false;
    run.deliveringSteers.add(itemId);
    const call = (async () => {
      const item = await options.queue?.beginDelivery(threadId, itemId);
      if (!item) { run.deliveringSteers.delete(itemId); return; }
      try {
        // Save the original identity before any asynchronous runtime acceptance.
        await run.recordSteer?.(item);
        if (run.stopped || run.retired) return;
        await runner.steer!(text, itemId);
        if (run.retired || owners.get(threadId) !== run) return;
        await options.queue?.markAccepted(threadId, itemId, true);
        run.acceptedSteers.add(itemId);
      } catch (error) {
        log.warn(`线程 ${threadId} 的引导没能送进当前回合，保留待发送消息`, error);
      } finally {
        if (!run.retired && owners.get(threadId) === run && !run.acceptedSteers.has(itemId))
          await options.queue?.markAccepted(threadId, itemId, false);
        run.deliveringSteers.delete(itemId);
      }
    })();
    run.steerCalls.add(call);
    await call.finally(() => run.steerCalls.delete(call));
    return run.acceptedSteers.has(itemId);
  };
  /** Cleanup remains visible until the runner can no longer write resume state. */
  const finishing = new Map<string, Promise<void>>();
  /**
   * Engines whose turn ended waiting on the human. They are *not* stopped: the
   * harness answers `stop()` on an unfinished turn with a continuation payload
   * addressed to the bridge the same call kills, which is unresumable. The next
   * turn on the thread either continues on this very session (tool message) or
   * destroys it and starts over (new user prompt).
   */
  const parked = new Map<string, ParkedEngine>();

  /**
   * The 计划文档 a finished Plan turn leaves behind: the assistant message's text
   * parts, joined. Never throws, and an empty answer overwrites nothing.
   */
  const savePlanFrom = async (threadId: string, assistant: UIMessage | undefined): Promise<void> => {
    if (options.savePlan == null || assistant == null) return;
    // Only the text *after* the last tool call. Everything before it is the
    // agent narrating its research ("我先看一下 …"), and gluing that to the
    // plan gives the user a document whose first line is not part of the plan.
    const lastNonText = assistant.parts.findLastIndex((part) => part.type !== "text");
    const content = assistant.parts
      .slice(lastNonText + 1)
      .map((part) => (part as { text: string }).text)
      .join("\n\n")
      .trim();
    // The turn ended on a tool call, so it produced no plan; the previous one stands.
    if (content === "") return;
    await options.savePlan(threadId, content).catch((error: unknown) => log.warn(`保存线程 ${threadId} 的计划文档失败`, error));
  };

  /** Never throws: a diff we could not count must not turn a good turn into a failed one. */
  const measureChanges = async (thread: ThreadRecord): Promise<ChangeStats | undefined> => {
    if (options.changeStats == null) return undefined;
    try {
      return await options.changeStats(thread);
    } catch (error) {
      log.warn(`统计线程 ${thread.id} 的改动失败`, error);
      return undefined;
    }
  };

  /**
   * Fold the client's latest message into the stored thread. `useChat` posts
   * the whole array; only its tail is new — either a fresh user message, or the
   * assistant message re-sent with approval responses / client tool outputs.
   */
  const mergeIncoming = (stored: UIMessage[], incoming: UIMessage[]): UIMessage[] => {
    const last = incoming.at(-1);
    if (last == null) return stored;
    const position = stored.findIndex((message) => message.id === last.id);
    if (position >= 0) {
      const next = [...stored];
      next[position] = last;
      return next;
    }
    return [...stored, last];
  };

  /**
   * 每回合开始前的工作目录快照, stamped onto the user message that starts the
   * turn so 「恢复到此处」 knows where to go back to.
   *
   * Only a turn a *new user message* starts gets one: an approval answer or a
   * question reply continues the turn whose checkpoint already describes the
   * tree it began from. `undefined` — never a throw — for a continuation, a
   * directory that is not a git repo, or a snapshot that failed.
   */
  const checkpointForTurn = async (thread: ThreadRecord, incoming: UIMessage[]): Promise<MessageCheckpoint | undefined> => {
    if (incoming.at(-1)?.role !== "user") return undefined;
    const project = await projectOfThread(projects, dataDir, thread).catch(() => undefined);
    if (project == null) return undefined;
    const repoPath = thread.workspace?.path ?? project.repoPath;
    const startedAt = Date.now();
    const taken = await createCheckpoint({ repoPath, threadId: thread.id, log });
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SLOW_CHECKPOINT_MS) log.warn(`线程 ${thread.id} 的回合快照耗时 ${elapsed}ms`);
    if (taken != null) await recordBaseline(thread, repoPath, taken.commit);
    return taken == null ? undefined : { ...taken, at: new Date().toISOString() };
  };

  /**
   * 任务基线 of a task running in the user's own checkout: the snapshot its very
   * first turn started from, pinned under a ref of its own. Everything 改动 and
   * 提交 look at is measured against it, so the work the user already had lying
   * around uncommitted is never counted as the task's — and never committed
   * under its name. A worktree task has `workspace.baseCommit` for that.
   *
   * On the record rather than on the message: `/compact` replaces the messages,
   * and losing the baseline with them would put the task back on HEAD.
   */
  const recordBaseline = async (thread: ThreadRecord, repoPath: string, commit: string): Promise<void> => {
    if (thread.workspace != null || thread.baselineCommit != null) return;
    const pinned = await pinBaseline({ repoPath, threadId: thread.id, commit, log });
    if (pinned == null) return;
    await threads.update(thread.id, { baselineCommit: pinned }).catch((error: unknown) => {
      log.warn(`线程 ${thread.id} 的任务基线没能记下`, error);
    });
  };

  /** The incoming list with the checkpoint stamped onto its last (user) message. */
  const withCheckpoint = (incoming: UIMessage[], checkpoint: MessageCheckpoint | undefined): UIMessage[] => {
    const last = incoming.at(-1);
    if (checkpoint == null || last == null) return incoming;
    const metadata: ThreadMessageMetadata = { ...(last.metadata as ThreadMessageMetadata | undefined), checkpoint };
    return [...incoming.slice(0, -1), { ...last, metadata }];
  };

  /** The user message one turn hangs off: the last one carrying a 每回合快照. */
  const turnMessageIndex = (messages: readonly UIMessage[], before = messages.length): number => {
    for (let i = Math.min(before, messages.length) - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === "user" && (message.metadata as ThreadMessageMetadata | undefined)?.checkpoint != null) return i;
    }
    return -1;
  };

  /** `messages` with `patch` merged into the metadata of message `index`. */
  const stampMetadata = (messages: readonly UIMessage[], index: number, patch: ThreadMessageMetadata): UIMessage[] => {
    const message = messages[index]!;
    const next = [...messages];
    next[index] = { ...message, metadata: { ...(message.metadata as ThreadMessageMetadata | undefined), ...patch } };
    return next;
  };

  /**
   * A previous turn that never got its own after-snapshot — the process died on
   * it, or it was abandoned while parked on an approval — borrows this turn's
   * before-snapshot as its end state. It is the tree the user is looking at as
   * they send the next message, so it is the truest answer left; the edits they
   * made in between ride along with that turn, the same imprecision a turn that
   * ends normally already has.
   */
  const withAfterFallback = (messages: readonly UIMessage[], checkpoint: MessageCheckpoint | undefined): UIMessage[] => {
    if (checkpoint == null) return [...messages];
    const index = turnMessageIndex(messages, messages.length - 1);
    if (index < 0) return [...messages];
    const metadata = messages[index]!.metadata as ThreadMessageMetadata | undefined;
    if (metadata?.checkpointAfter != null) return [...messages];
    return stampMetadata(messages, index, { checkpointAfter: checkpoint });
  };

  /**
   * 回合结束后的快照, taken once the turn is really over and the engine is put
   * away. Deliberately *after* the status update the user is watching for — the
   * task reads 空闲 the moment it is — and before `scheduleDispatch`, so the
   * next queued turn starts from a tree this one has already been measured
   * against. Never throws: a snapshot we could not take only costs that turn its
   * file list.
   */
  const snapshotTurnEnd = async (threadId: string): Promise<void> => {
    const record = await threads.get(threadId).catch(() => undefined);
    if (record == null) return;
    const index = turnMessageIndex(record.messages);
    if (index < 0) return;
    const before = (record.messages[index]!.metadata as ThreadMessageMetadata).checkpoint!;
    const project = await projectOfThread(projects, dataDir, record).catch(() => undefined);
    if (project == null) return;
    const repoPath = record.workspace?.path ?? project.repoPath;
    const startedAt = Date.now();
    const taken = await createAfterCheckpoint({ repoPath, threadId, before, log });
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SLOW_CHECKPOINT_MS) log.warn(`线程 ${threadId} 的回合结束快照耗时 ${elapsed}ms`);
    if (taken == null) return;
    const checkpointAfter: MessageCheckpoint = { ...taken, at: new Date().toISOString() };
    await threads
      .update(threadId, { messages: stampMetadata(record.messages, index, { checkpointAfter }) })
      .catch(async (error: unknown) => {
        log.warn(`线程 ${threadId} 的回合结束快照没能记下`, error);
        // 删除任务 can land in the moment this snapshot was being taken, and the
        // ref it just wrote would then outlive the task in the user's own repo.
        if ((await threads.get(threadId).catch(() => undefined)) == null) {
          await deleteCheckpoints({ repoPath, threadId, log });
        }
      });
  };

  const deriveStatus = (assistant: UIMessage | undefined): ThreadStatus => {
    if (assistant == null) return "idle";
    for (const part of assistant.parts) {
      if (isToolUIPart(part) && part.state === "approval-requested") return "awaiting-approval";
    }
    for (const part of assistant.parts) {
      // A tool call with an input but no output and no execute on the server
      // (`askUserQuestions`) is waiting for the human, not for the engine.
      if (isToolUIPart(part) && part.state === "input-available") return "awaiting-input";
    }
    return "idle";
  };

  /**
   * Forget a suspended turn. `continueFrom` on disk is a promise that some
   * bridge is still holding the turn open; once its runner is destroyed — or
   * once attaching to it failed — that promise is false and the file must not
   * tempt the next turn into attaching again. Whatever `resumeFrom` the file
   * carries is kept: that one is still the last finished turn.
   */
  const clearContinueFrom = async (threadId: string): Promise<void> => {
    const state = await threads.loadHarnessState(threadId).catch(() => undefined);
    if (state?.continueFrom == null) return;
    const { continueFrom: _dropped, ...rest } = state;
    await threads
      .saveHarnessState(threadId, { ...rest, updatedAt: new Date().toISOString() })
      .catch((error) => log.warn(`清除线程 ${threadId} 的续跑状态失败`, error));
  };

  /** Release a parked engine and close the tool parts its turn left hanging. */
  const releaseParked = async (threadId: string, toolErrorText: string, threadError?: string): Promise<void> => {
    const entry = parked.get(threadId);
    if (entry == null) return;
    parked.delete(threadId);
    await entry.runner.destroy().catch((error) => log.warn(`销毁挂起的引擎失败 (thread ${threadId})`, error));
    await clearContinueFrom(threadId);
    const record = await threads.get(threadId).catch(() => undefined);
    if (record == null) return;
    await threads
      .update(threadId, {
        messages: closePendingToolParts(record.messages, toolErrorText),
        status: "interrupted",
        error: threadError,
      })
      .catch((error) => log.warn(`标记线程 ${threadId} 中断失败`, error));
  };

  const runTurn = async (thread: ThreadRecord, incoming: UIMessage[], run: LiveRun, note?: string): Promise<void> => {
    const stored = await projectOfThread(projects, dataDir, thread);
    if (stored == null) throw new NotFoundError(`项目不存在: ${thread.projectId}`, "project_not_found");
    // A worktree task sees its own directory as the repo. Nothing below the
    // engine factories knows the difference — they all read `repoPath` only.
    const project = thread.workspace != null ? { ...stored, repoPath: thread.workspace.path } : stored;

    const factory = registry[thread.engine];
    if (factory == null) throw new BadRequestError(`未知引擎: ${thread.engine}`, "unknown_engine");

    const runRecord: NonNullable<ThreadMessageMetadata["run"]> = {
      id: randomUUID(),
      engine: thread.engine,
      ...(thread.model ? { model: thread.model } : {}),
      startedAt: new Date().toISOString(),
      stopReason: "running",
    };
    const owns = () => owners.get(thread.id) === run && !run.retired;
    const writeRun = <T>(work: () => Promise<T>): Promise<T | undefined> =>
      locked(writing, thread.id, async () => owns() ? work() : undefined);
    const updateRun = (patch: ThreadPatch) => writeRun(() => threads.update(thread.id, patch));
    let messages = withRunRecord(incoming, runRecord);
    const durableSteers = new Map<string, QueuedMessage>();
    const pushedSteers = new Set<string>();
    let runner: EngineRunner | undefined;
    let assistant: UIMessage | undefined;
    let lastPersistedAt = 0;
    /** Set from the first `error` chunk the engine stream produced, if any. */
    let streamError: string | undefined;
    /** The same error's raw, unmasked message — for the persisted thread record. */
    let rawStreamError: string | undefined;
    let park = false;
    let finishReason: string | undefined;
    let steps = 0;
    /** This turn's steps added up so far, so the context card's 累计 moves while the turn runs. */
    let turnUsage: UsageInfo | undefined;

    /**
     * The history with this turn's assistant message folded in — or unchanged
     * when the turn produced nothing renderable. A turn that only errors out
     * still yields a message from `readUIMessageStream`, and storing that empty
     * shell leaves the thread with an assistant bubble that renders nothing,
     * converts to nothing, and confuses every later read of the history.
     */
    const withAssistant = (message: UIMessage | undefined): UIMessage[] => {
      let value = message;
      if (durableSteers.size > 0) {
        value ??= { id: runRecord.id, role: "assistant", parts: [] };
        const parts = [...value.parts];
        for (const item of durableSteers.values()) {
          if (!parts.some((part) => part.type === "data-steer" && (part as { id?: string }).id === item.id)) {
            parts.push({ type: "data-steer", id: item.id, data: { text: item.text, messageId: item.id, ...(pushedSteers.has(item.id) ? { receipt: true } : {}) } });
          }
        }
        value = { ...value, parts };
      }
      return withRunRecord(value != null && value.parts.length > 0 ? mergeIncoming(messages, [value]) : messages, runRecord);
    };
    const persist = async (message: UIMessage) => {
      if (message.parts.length === 0) return;
      const save = () => writeRun(() => threads.saveMessages(thread.id, withAssistant(message)));
      await save();
    };

    run.recordSteer = async (item) => {
      durableSteers.set(item.id, item);
      pushedSteers.add(item.id);
      run.hub.publish(steerChunk(item.text, item.id, true));
      await writeRun(() => threads.saveMessages(thread.id, withAssistant(assistant)));
    };
    run.flush = async () => {
      await updateRun({ messages: withTurnEnd(withAssistant(assistant), { status: "interrupted", reason: STOP_INTERRUPT_TEXT }) });
    };

    // A turn that continues the last assistant message (an approval answer, a
    // client tool result) streams chunks that address parts that message
    // already holds — `toUIMessageStream` reuses its id for exactly that
    // reason. The server rebuilds the same message the client does, so its
    // reader has to start from it, not from a blank one.
    const previous = incoming.at(-1);
    const resumed = previous?.role === "assistant" ? previous : undefined;
    // The paused step can leave a call half-announced (`tool-input-start` but no
    // input yet). The harness re-issues it in the continuation's *new* step, and
    // the SDK's reader only reconciles a `tool-input-start` against the parts of
    // the current step — so a seed still carrying the old `input-streaming` part
    // ends up with two parts for one `toolCallId`. They are dropped from the
    // seed (a copy; the stored history is untouched) and kept aside: whatever
    // the continuation never re-issues is closed when the turn ends.
    // `convertToModelMessages` skips `input-streaming` parts anyway, so nothing
    // about the messages the engine sees changes.
    const seed = resumed != null ? dropStreamingToolParts(resumed) : undefined;

    // Subscribe before the engine starts: the hub replays from chunk 0 anyway,
    // but this way the reader is already draining while the turn runs.
    const reader = (async () => {
      for await (const message of readUIMessageStream({
        stream: run.hub.subscribe(),
        ...(seed != null ? { message: seed.message } : {}),
        onError: (error) => log.warn(`重建线程 ${thread.id} 的助手消息出错`, error),
      })) {
        assistant = message;
        const now = Date.now();
        if (now - lastPersistedAt >= PERSIST_INTERVAL_MS) {
          lastPersistedAt = now;
          await persist(message).catch((error) => log.warn(`中途保存线程 ${thread.id} 失败`, error));
        }
      }
    })();

    const runHooks: RunHooks = {
      // 插话, pulled: the engine drains the queue between its steps. Each
      // message shows up in the log at the point it went in.
      takeSteers: async () => {
        if (options.queue == null || run.stopped || !owns()) return [];
        const added: string[] = [];
        let items: QueuedMessage[];
        try {
          items = (await writeRun(() => options.queue!.takeSteers(thread.id, (taken) => {
            for (const item of taken) {
              durableSteers.set(item.id, item);
              added.push(item.id);
            }
            return withAssistant(assistant);
          }))) ?? [];
        } catch (error) {
          for (const id of added) durableSteers.delete(id);
          throw error;
        }
        for (const item of items) run.hub.publish(steerChunk(item.text, item.id));
        return items.map((item) => item.text);
      },
      steerApplied: async (messageId) => {
        await writeRun(async () => { await options.queue?.markApplied(thread.id, messageId); });
      },
      saveTaskState: async (state) => {
        await updateRun({ taskState: state });
      },
      saveHarnessState: async (state) => { await writeRun(() => threads.saveHarnessState(thread.id, state)); },
    };
    let hookBinding = { current: runHooks };

    try {
      // Include the durable start in the same cleanup boundary as the stream.
      // A disk failure must release this run's slot too.
      await writeRun(() => threads.saveMessages(thread.id, messages));
      // 恢复之后的第一轮: the note rides on the converted history rather than on
      // the stored message, so the log still shows what the user typed.
      // 附件: the stored messages keep their `file` parts for the log; the
      // engine gets them as paths, or as parts it can really read.
      const readable = await prepareAttachments(messages, {
        engine: thread.engine,
        dir: join(dataDir, "attachments", thread.id),
      });
      // 插话 parts are read back as the user messages they were.
      const convert = async (tools?: ToolSet) =>
        withRestoreNote(await convertToModelMessages(expandSteers(readable, new Set(thread.queue?.filter(item => item.mode === "steer" && !item.applied).map(item => item.id))), ...(tools != null ? [{ tools }] : [])), note);
      let modelMessages = await convert();
      // The harness itself decides "continue the open turn" vs "start a new
      // one" by whether the last model message is `role: 'tool'` (approval
      // responses / tool results), so the run manager reads it the same way.
      const continuesTurn = modelMessages.at(-1)?.role === "tool";
      const parkedEntry = parked.get(thread.id);
      const parkedRunner = parkedEntry?.runner;

      if (parkedRunner != null && continuesTurn) {
        parked.delete(thread.id);
        runner = parkedRunner;
        hookBinding = parkedEntry!.hooks;
        hookBinding.current = runHooks;
      } else {
        if (parkedRunner != null) {
          // A fresh prompt abandons the parked turn. The session cannot take a
          // new prompt while its turn is unfinished (`requirePromptableTurn`
          // throws), so it is destroyed and a new one starts from the last
          // *finished* turn's resume state. The stored history has to be closed
          // too, or the client keeps rendering an approval button for a turn
          // that no longer exists. Closing to `output-error` is also what makes
          // the history convertible: `convertToModelMessages` emits the closed
          // parts as a `tool` message *before* the new user message, so the
          // trailing message stays `user` and the harness starts a prompt turn.
          parked.delete(thread.id);
          await parkedRunner.destroy().catch((error) => log.warn(`销毁挂起的引擎失败 (thread ${thread.id})`, error));
          await writeRun(() => clearContinueFrom(thread.id));
          messages = closePendingToolParts(messages, ABANDONED_TURN_TEXT);
          modelMessages = await convert();
        }
        // Read after the abandon path above, so a cleared `continueFrom` is
        // really gone by the time the runner could act on it.
        const harnessState = await threads.loadHarnessState(thread.id);
        // 运行模式 is global and read here, at turn start: an engine that cannot
        // ask runs 全自动 whatever the setting says.
        const permission = effectivePermission(factory.descriptor.capabilities, await settings.get());
        runner = await factory.create({
          thread,
          project,
          projectPath: stored.repoPath,
          dataDir,
          permissionMode: permission.permissionMode,
          alwaysAllow: permission.alwaysAllow,
          planMode: thread.mode === "plan",
          ...(harnessState != null ? { harnessState } : {}),
          // A parked runner was reused above, so reaching here with
          // `continuesTurn` means the open turn lives in another process.
          continuesTurn,
          takeSteers: () => hookBinding.current.takeSteers(),
          steerApplied: (id) => hookBinding.current.steerApplied(id),
          saveTaskState: (state) => hookBinding.current.saveTaskState!(state),
          saveHarnessState: (state) => hookBinding.current.saveHarnessState(state),
          log,
        });
      }

      // A runner with its own in-process tools has to convert the history with
      // them: `toModelOutput` is what turns a stored subagent transcript back
      // into the summary the model actually saw, and it only runs here. The
      // first conversion above cannot do it — the runner does not exist yet,
      // and picking it needs `continuesTurn`, which needs the conversion.
      if (runner.tools != null) modelMessages = await convert(runner.tools);

      const result = await runner.stream({ messages: modelMessages, abortSignal: run.abort.signal });
      run.runner = runner;
      for (const item of (await threads.get(thread.id))?.queue ?? []) {
        if (item.mode === "steer" && item.accepted) run.acceptedSteers.add(item.id);
      }
      // Messages submitted while the engine was still starting belong to this
      // turn. Explicit queue items never pass through this path.
      if (runner.steer != null && options.queue != null) {
        const pending = (await threads.get(thread.id))?.queue?.filter((item) => item.mode === "steer" && item.accepted !== true) ?? [];
        for (const item of pending) await deliverSteer(thread.id, item.text, item.id);
      }

      // `onError` below is asked about two different things and cannot tell
      // them apart: an `error` chunk, which ends the turn, and a tool call
      // that failed, which the agent reads and carries on from. Noting the
      // tool errors as they pass is what separates them.
      const toolErrors = new Set<unknown>();
      const engineStream = result.stream.pipeThrough(
        new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
          transform(part, controller) {
            runRecord.lastEvent = part.type;
            if (part.type === "finish") finishReason = part.finishReason;
            if (part.type === "finish-step") {
              steps += 1;
              runRecord.steps = steps;
            }
            const observed = runner?.outcome?.();
            if (observed) runRecord.providerAttempts = observed.providerAttempts;
            if (part.type === "tool-error") toolErrors.add(part.error);
            // A harness compacting its context is not something the UI stream
            // converter knows; it becomes a data part of this turn instead.
            if (isCompactionPart(part)) {
              run.hub.publish(compactionChunk(part));
              return;
            }
            controller.enqueue(part);
          },
        }),
      );

      const uiStream = toUIMessageStream({
        stream: engineStream,
        originalMessages: messages,
        generateMessageId: () => randomUUID(),
        onError: (error) => {
          // A failed tool call is part of the conversation: its text is what
          // the tool row shows and what the model is given again next turn, so
          // it stays as the tool wrote it. It is not the turn's error.
          if (toolErrors.has(error)) return rawErrorText(error);
          // The turn's own error: masked text to the client, raw text kept for
          // the thread record below.
          rawStreamError ??= rawErrorText(error);
          runRecord.errorClass = classifyFailure(error);
          return getHarnessErrorMessage(error);
        },
        // Token usage, attached to the assistant message so the composer's
        // context ring has a real number instead of an estimate. Every engine
        // funnels through here and the `HarnessV1` protocol carries the same
        // two parts, so this covers all three without per-engine wiring.
        //
        // `usage` is deliberately the *last* step's, not the sum: a step's
        // `inputTokens` is the prompt it sent, which is what "how full is the
        // context" means, while a sum over steps double-counts the history.
        // The reader merges each metadata object into the message, so a later
        // step simply overwrites the earlier one's numbers.
        //
        // `totalUsage` is the running sum of the steps until the turn's own
        // `finish` replaces it with the engine's figure — unless that figure
        // counts nothing, which would wipe out a sum that did.
        messageMetadata: ({ part }): ThreadMessageMetadata | undefined => {
          if (part.type === "finish-step") {
            const step = toUsageInfo(part.usage);
            if (!counted(step)) return { usage: step };
            turnUsage = turnUsage == null ? step : addUsageInfo(turnUsage, step);
            return { usage: step, totalUsage: turnUsage };
          }
          if (part.type === "finish") {
            const total = toUsageInfo(part.totalUsage);
            return counted(total) || turnUsage == null ? { totalUsage: total } : { totalUsage: turnUsage };
          }
          return undefined;
        },
      });

      const streamReader = uiStream.getReader();
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) break;
        // An `error` part inside an otherwise well-formed stream still means the
        // turn failed; without this the thread would settle as a clean `idle`.
        if (value.type === "error") streamError ??= value.errorText;
        run.hub.publish(withChunkInput(value));
      }
      run.hub.close();
      await reader;

      const outcome = runner.outcome?.();
      const derived = deriveStatus(assistant);
      const incomplete = derived === "idle" && outcome != null && outcome.stopReason !== "response";
      const status = streamError != null ? "error" : incomplete ? "interrupted" : derived;
      Object.assign(runRecord, outcome ?? { steps, ...(finishReason ? { finishReason } : {}) }, {
        endedAt: new Date().toISOString(),
        stopReason: streamError
          ? "error"
          : park
            ? "waiting"
            : derived === "awaiting-approval" || derived === "awaiting-input"
              ? derived
              : (outcome?.stopReason ?? (finishReason ? "response" : "unknown")),
      });
      const incompleteReason =
        outcome?.stopReason === "budget" ? "执行预算已用尽；请根据已保存的进展继续。" : "这一轮没有完整结束；请核实已执行操作后继续。";
      run.completedNormally = status === "idle";
      if (!run.stopped) reportTurn(thread.engine, status !== "error", assistant);
      park = !run.stopped && (status === "awaiting-approval" || status === "awaiting-input");
      // A turn that is over has nothing left that could finish a half-streamed
      // call: either the engine re-issued it in a later step, or it never will
      // (a denied approval ends the turn on the spot). A parked turn keeps its
      // open parts — its step is still running inside the engine.
      const settled = park || run.stopped ? assistant : settleStreamingToolParts(assistant, seed?.dropped);

      if (!run.stopped && owns()) {
        const stats = await measureChanges(thread);
        // 计划回合的最终回复就是计划文档。Only a turn that really ended writes it:
        // one parked on a question is still mid-research, and an interrupted or
        // failed one has no plan to speak of.
        if (thread.mode === "plan" && status === "idle") await writeRun(() => savePlanFrom(thread.id, settled));
        await updateRun({
            messages: withTurnEnd(
              withAssistant(settled),
              streamError != null
                ? { status: "error", reason: rawStreamError ?? streamError }
                : incomplete
                  ? { status: "interrupted", reason: incompleteReason }
                  : undefined,
            ),
            status,
            error: streamError != null ? (rawStreamError ?? streamError) : incomplete ? incompleteReason : undefined,
            ...(stats != null ? { changeStats: stats } : {}),
            // 未读: the turn ended on its own, so whoever sent it has not seen
            // this yet. The client clears it when the task is really on screen.
            ...(marksUnread(status) ? { unread: true } : {}),
          })
          .catch(async (error) => {
            // Never let a failed final write leave the thread stuck `running`.
            log.error(`保存线程 ${thread.id} 的最终状态失败`, error);
            park = false;
            await updateRun({ status: "error", error: getHarnessErrorMessage(error), unread: true })
              .catch((fallback) => log.error(`记录线程 ${thread.id} 的错误状态也失败`, fallback));
          });
      } else {
        // 停止: recorded even when the turn had produced nothing yet, or the
        // question would sit in the log as if it had never been answered.
        Object.assign(runRecord, { endedAt: new Date().toISOString(), stopReason: "cancelled" });
        await updateRun({
          messages: withTurnEnd(withAssistant(settled), { status: "interrupted", reason: STOP_INTERRUPT_TEXT }),
        });
      }
    } catch (error) {
      park = false;
      // The frozen turn is gone. That is not an engine failure to report as
      // one: the thread settles into the same interrupted shape a hard restart
      // leaves behind, with every pending call closed, so the client stops
      // offering to answer a turn nobody holds any more.
      const resumeFailed = error instanceof TurnResumeFailedError;
      Object.assign(runRecord, runner?.outcome?.() ?? {}, {
        endedAt: new Date().toISOString(),
        stopReason: run.stopped ? "cancelled" : resumeFailed ? "unknown" : "error",
        errorClass: classifyFailure(error),
      });
      if (resumeFailed) await writeRun(() => clearContinueFrom(thread.id));
      if (!run.stopped && !resumeFailed) reportTurn(thread.engine, false, assistant);
      const message = error instanceof VgentServerError ? error.message : getHarnessErrorMessage(error);
      // The masked `message` above is what the client sees; the thread record
      // keeps the raw text for debugging (see `rawErrorText`).
      const rawMessage = error instanceof VgentServerError ? error.message : rawErrorText(error);
      log.error(`线程 ${thread.id} 运行失败: ${message}`);
      // A failure before or during the turn reaches the client as an `error`
      // chunk; `useChat` surfaces it instead of ending on a silent close.
      run.hub.publish({ type: "error", errorText: message });
      run.hub.interrupt(message);
      run.hub.close();
      await reader.catch(() => {});
      await updateRun({
          messages: withTurnEnd(
            resumeFailed
              ? closePendingToolParts(withAssistant(assistant), RESUME_FAILED_TEXT)
              : withAssistant(run.stopped ? assistant : settleStreamingToolParts(assistant, seed?.dropped)),
            run.stopped
              ? { status: "interrupted", reason: STOP_INTERRUPT_TEXT }
              : resumeFailed
                ? { status: "interrupted", reason: RESUME_FAILED_TEXT }
                : { status: "error", reason: rawMessage },
          ),
          status: run.stopped || resumeFailed ? "interrupted" : "error",
          ...(run.stopped ? {} : { error: rawMessage }),
        })
        .catch((updateError) => log.error(`记录线程 ${thread.id} 的错误状态失败`, updateError));
    } finally {
      await Promise.allSettled([...run.steerCalls]);
      run.hub.close();
      if (runner != null && !run.retired) {
        if (park && !run.stopped && owns()) {
          // Alive on purpose, and no harness file is written: `<id>.harness.json`
          // must keep the last *finished* turn's state.
          parked.set(thread.id, { runner, hooks: hookBinding, stateless: factory.statelessTurns === true });
        } else {
          // `finish()` persists resume state, which only a runtime with no turn
          // in flight can produce; anything else is torn down and the previous
          // file is kept.
          const engine = runner;
          const cleanup = (engine.hasUnfinishedTurn() ? engine.destroy() : engine.finish()).catch((error) =>
            log.warn(`结束引擎失败 (thread ${thread.id})`, error),
          );
          finishing.set(thread.id, cleanup);
          await cleanup;
          if (finishing.get(thread.id) === cleanup) finishing.delete(thread.id);
        }
      }
      if (!park) await writeRun(async () => {
        await options.queue?.settleSteers(thread.id,
          [...new Set([...run.acceptedSteers, ...durableSteers.keys()])], !run.completedNormally || run.stopped);
      }).catch(error => log.warn(`清理引导状态失败 (thread ${thread.id})`, error));
      // 回合结束后的快照, once the engine really is down and can write no more.
      // A parked turn is not over — its own continuation takes the snapshot when
      // it ends — so it is the one case with nothing to record yet.
      if (!park && owns()) await writeRun(() => snapshotTurnEnd(thread.id))
        .catch(error => log.warn(`保存回合结束快照失败 (thread ${thread.id})`, error));
      // 排队: the slot is free and the engine is put away, so the thread can
      // take its next queued message. `dispatchQueue` re-reads the record and
      // only acts on a clean `idle`, so a parked, stopped or failed turn here
      // simply leaves the queue where it is.
      delete run.runner;
      if (runs.get(thread.id) === run) runs.delete(thread.id);
      if (owns()) scheduleDispatch(thread.id);
    }
  };

  /**
   * Start a turn on a thread. The one path into the engine, whichever side
   * asked: an HTTP `POST /api/chat/:id`, the 排队 dispatcher below, or the
   * 「发送」 route. Everything a turn needs to be a real turn — the setup wait,
   * 每回合快照, Plan mode, the title, the cleared 收口 — lives here.
   */
  const startTurnUnlocked = async (threadId: string, uiMessages: unknown): Promise<ChunkHub> => {
    const active = runs.get(threadId);
    if (active != null) {
      if (active.stopped) throw new ConflictError("引擎仍在停止，请稍后重试", "thread_stopping");
      if (!active.hub.closed) throw new ConflictError(`线程已在运行: ${threadId}`, "thread_running");
      // The turn is over — the client saw the stream close — and the run is
      // only finishing its bookkeeping. Answering an approval that fast is
      // normal, so wait for the slot instead of rejecting it.
      await active.done.catch(() => {});
    }
    // A fresh worktree may still be installing dependencies: the user could
    // submit their first message the moment the task appeared. A *failed*
    // setup does not hold the turn back — the task simply runs without it.
    await options.whenWorkspaceReady?.(threadId);
    await whenSetupSettled(threadId);
    // The previous turn's engine may still be persisting its resume state.
    await finishing.get(threadId);
    // Read after both waits: the preceding turn may have written its final
    // assistant message while this follow-up was waiting for its slot.
    const thread = await threads.get(threadId);
    if (thread == null) throw new NotFoundError(`线程不存在: ${threadId}`, "thread_not_found");
    // 归档中 / 恢复中: the worktree is being taken apart or put back.
    if (thread.transition != null) {
      throw new ConflictError(`任务正在${thread.transition === "archiving" ? "归档" : "恢复"}，稍等`, "thread_transitioning");
    }
    if (thread.workspaceState != null) {
      throw new ConflictError(thread.error ?? "工作目录尚未就绪，请稍后重试", "workspace_not_ready");
    }
    if (thread.workspace?.reclaimed === true) {
      throw new ConflictError("此任务的工作目录已回收，请先恢复后再运行", "workspace_reclaimed");
    }
    const factory = registry[thread.engine];
    if (factory == null) throw new BadRequestError(`未知引擎: ${thread.engine}`, "unknown_engine");
    // Awaited: the probe can touch the filesystem (a login store, an
    // environment credential), and a rejected precondition has to become the
    // HTTP response instead of an unhandled rejection.
    await factory.ensureAvailable?.({ thread, dataDir });

    const repaired = Array.isArray(uiMessages) ? withToolInputs(uiMessages as UIMessage[]) : uiMessages;
    const result = await safeValidateUIMessages({ messages: repaired });
    if (!result.success) {
      // The SDK's message carries the whole history as JSON — for the log, not the user.
      log.warn(`线程 ${threadId} 的消息未通过校验`, result.error);
      throw new BadRequestError(`消息格式不合法${await locateInvalid(repaired)}`, "invalid_messages");
    }
    const validated = result.data;
    if (validated.length === 0) throw new BadRequestError("消息为空", "invalid_messages");

    // Setup has settled and the engine has not started: this is the moment
    // the working directory still looks the way the user saw it.
    const checkpoint = await checkpointForTurn(thread, validated);
    // The client posts the history back, but only its tail is merged: the stored
    // copy needs the same repair, or the engine converts the broken parts.
    // A turn picked back up (an approval answered after a stop, say) is no
    // longer ended; a new user message has no ending to clear.
    const messages = withTurnEnd(
      withAfterFallback(withToolInputs(mergeIncoming(
        withoutPromotedSteers(thread.messages, validated.filter(input => input.role === "user" &&
          thread.queue?.some(item => item.mode === "steer" && item.id === input.id))),
        withCheckpoint(validated, checkpoint),
      )), checkpoint),
      undefined,
    );
    // 从恢复点继续: the marker goes away with this message — the task is moving
    // forward from here — and the model is told once, in this turn's input, what
    // happened to the files it may remember writing.
    const restored =
      thread.restoredTo != null && validated.at(-1)?.role === "user"
        ? restoreNote(thread.messages, thread.restoredTo.messageId)
        : undefined;
    // 分叉后的第一轮: an engine whose session keeps its own history has none of
    // what the fork copied, so that turn carries it as text. Said once.
    const forked = thread.forkedFrom?.pending === true && factory.statelessTurns !== true ? forkNote(thread.messages) : undefined;
    const note = [forked, restored].filter((part) => part != null).join("\n\n") || undefined;
    // A thread is named by its first user message; an explicit title is kept.
    const title = thread.title === DEFAULT_THREAD_TITLE ? deriveThreadTitle(messages) : undefined;
    const updated = await threads.update(threadId, {
      messages,
      consumeQueueIds: messages.filter((message) => message.role === "user").map((message) => message.id),
      status: "running",
      error: undefined,
      // The task is working again, so whatever it was wound up as no longer
      // describes what is on disk.
      outcome: undefined,
      restoredTo: undefined,
      ...(thread.forkedFrom?.pending === true
        ? { forkedFrom: { threadId: thread.forkedFrom.threadId, messageId: thread.forkedFrom.messageId } }
        : {}),
      ...(title != null ? { title } : {}),
    });

    const run: LiveRun = {
      hub: createChunkHub(),
      abort: new AbortController(),
      done: Promise.resolve(),
      stopped: false,
      acceptedSteers: new Set(),
      deliveringSteers: new Set(),
      steerCalls: new Set(),
      completedNormally: false,
    };
    runs.set(threadId, run);
    owners.set(threadId, run);
    // Detached on purpose: an HTTP client disconnecting must not cancel the turn.
    run.done = runTurn(updated, messages, run, note);
    run.done.catch((error) => log.error(`线程 ${threadId} 的运行崩溃`, error));

    return run.hub;
  };
  const startTurn = (threadId: string, uiMessages: unknown): Promise<ChunkHub> =>
    locked(starting, threadId, () => startTurnUnlocked(threadId, uiMessages));

  /**
   * 排队 dispatch: pull the head of the queue out and run it as an ordinary
   * turn. `itemId` names one item instead — that is what 「发送」 does on a
   * queue the user paused.
   *
   * The item is removed before the turn starts, so nothing can edit or delete
   * one that is already on its way to the engine, and it is put back at the
   * head whenever the start fails — including the 409 a client's own `POST
   * /api/chat` wins by a hair. Never two turns, never a lost message.
   */
  const runQueued = async (threadId: string, itemId?: string): Promise<QueuedMessage | undefined> => {
    if (options.queue == null) return undefined;
    const queue = options.queue;
    const item = await queue.take(threadId, { ...(itemId ? { itemId } : {}), retain: true });
    if (item == null) return undefined;
    try {
      // Built the way the web builds it, because from here on it is the same
      // message: `start` stamps its checkpoint and folds it into the history.
      await startTurn(threadId, [{ id: item.id, role: "user", parts: [{ type: "text", text: item.text }] }]);
      return item;
    } catch (error) {
      await queue.putBack(threadId, item).catch((failure: unknown) => log.error(`排队消息放回线程 ${threadId} 失败`, failure));
      throw error;
    }
  };

  /**
   * The next queued message, if this thread is really free to take it. A turn
   * that stopped on an approval, a question, an error or 停止 is *not* over, so
   * its queue stays put until the user says otherwise.
   */
  const dispatchQueue = (threadId: string): Promise<void> =>
    locked(dispatching, threadId, async () => {
      if (options.queue == null || runs.has(threadId)) return;
      const thread = await threads.get(threadId).catch(() => undefined);
      if (thread == null || thread.archivedAt != null || thread.transition != null || thread.status !== "idle") return;
      if ((thread.queue?.length ?? 0) === 0) return;
      const item = await runQueued(threadId).catch((error: unknown) => {
        log.warn(`线程 ${threadId} 的排队消息没能发出`, error);
        return undefined;
      });
      if (item != null) log.info(`线程 ${threadId} 自动发出了一条排队消息`);
    });

  /**
   * Scheduled, never called inline from a turn's `finally`: the slot has to be
   * really free and the stack really unwound before the next turn starts, or a
   * queue of twenty would nest twenty turns deep.
   */
  const scheduleDispatch = (threadId: string): void => {
    if (options.queue == null) return;
    const timer = setTimeout(() => {
      void dispatchQueue(threadId);
    }, 0);
    timer.unref?.();
  };

  return {
    start: startTurn,

    async sendQueued(threadId, itemId) {
      const item = await runQueued(threadId, itemId);
      if (item == null) throw new NotFoundError("这条排队消息不存在", "queue_item_not_found");
    },

    dispatchQueue,

    steer: deliverSteer,

    async stop(threadId) {
      const hadParked = parked.has(threadId);
      await releaseParked(threadId, STOP_INTERRUPT_TEXT);
      if (hadParked) {
        const items = (await threads.get(threadId))?.queue?.filter(item => item.mode === "steer") ?? [];
        await options.queue?.settleSteers(threadId, items.map(item => item.id), true);
      }
      const run = runs.get(threadId);
      if (run == null) return;
      run.stopped = true;
      run.abort.abort();
      run.hub.interrupt(STOP_INTERRUPT_TEXT);
      run.hub.close();
      await threads.update(threadId, { status: "interrupted" }).catch((error) => log.warn(`标记线程 ${threadId} 中断失败`, error));
      // An engine that ignores its abort signal must not hold the slot — and
      // with it SIGTERM — forever. After the deadline the run keeps draining in
      // the background, but the thread is startable again.
      const timedOut = await Promise.race([
        run.done.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), stopTimeoutMs).unref?.()),
      ]);
      if (timedOut) {
        log.warn(`线程 ${threadId} 在 ${stopTimeoutMs}ms 内没有停下，关闭引擎并隔离旧回合`);
        await run.runner?.destroy();
        await run.flush?.();
        await locked(writing, threadId, async () => { run.retired = true; });
        await options.queue?.settleSteers(threadId, [...new Set([...run.acceptedSteers, ...run.deliveringSteers])], true);
        if (runs.get(threadId) === run) runs.delete(threadId);
      }
    },

    subscribe(threadId, signal) {
      // A run entry that is still finalizing counts: the hub replays what it
      // buffered and then closes, which is exactly what a reconnecting client
      // needs. Only "no run at all" is a 204.
      const run = runs.get(threadId);
      if (run == null) return undefined;
      return run.hub.subscribe(signal);
    },

    isRunning(threadId) {
      const run = runs.get(threadId);
      return run != null && !run.hub.closed;
    },

    async stopAll() {
      await Promise.all([...runs.keys()].map((threadId) => this.stop(threadId)));
      // A stateless engine holds nothing — the pending approval is just an open
      // tool part in the stored messages, and the next `start` builds a fresh
      // runner from them — so its runner is dropped and the thread is left
      // exactly as it is. A stateful one keeps its turn inside a runtime that
      // can outlive this process: `suspend()` freezes the turn and leaves that
      // runtime up, and the state it returns is what the next process attaches
      // to. Only when there is no such state — no `suspend`, or it failed — is
      // the pending approval closed, because then the client really would be
      // answering a turn that no longer exists.
      await Promise.all(
        [...parked.entries()].map(async ([threadId, entry]) => {
          if (entry.stateless) {
            parked.delete(threadId);
            await entry.runner.destroy().catch((error) => log.warn(`销毁挂起的引擎失败 (thread ${threadId})`, error));
            return;
          }
          if (entry.runner.suspend != null) {
            try {
              const state = await entry.runner.suspend();
              await threads.saveHarnessState(threadId, state);
              parked.delete(threadId);
              log.info(`线程 ${threadId} 的未完成轮次已挂起，重启后可继续`);
              return;
            } catch (error) {
              // The runner is spent either way (`suspend()` detaches before it
              // can fail on persistence), so fall through to the old path: it
              // closes the pending call and marks the thread interrupted.
              log.warn(`挂起线程 ${threadId} 的未完成轮次失败，改为中断`, error);
            }
          }
          await releaseParked(threadId, RESTART_PENDING_TOOL_TEXT, RESTART_INTERRUPT_TEXT);
        }),
      );
    },
  };
}

/**
 * 恢复之后的第一轮: the one sentence appended to the last user message of the
 * *converted* history.
 *
 * That message is the one every engine is guaranteed to read — the harness
 * sessions collapse the array down to exactly it — so this reaches Claude Code,
 * Codex and the self-built engine alike without a per-engine hook. It is also
 * why the note lives here rather than on the stored `UIMessage`: the work log
 * goes on showing what the user actually typed.
 */
export function withRestoreNote(messages: ModelMessage[], note: string | undefined): ModelMessage[] {
  if (note == null) return messages;
  const index = messages.findLastIndex((message) => message.role === "user");
  if (index < 0) return messages;
  const message = messages[index]!;
  const content =
    typeof message.content === "string" ? `${message.content}\n\n${note}` : [...message.content, { type: "text" as const, text: note }];
  const next = [...messages];
  next[index] = { ...message, content } as ModelMessage;
  return next;
}

const UNFINISHED_STATUSES: readonly ThreadStatus[] = ["running", "awaiting-approval", "awaiting-input"];

/**
 * A thread left mid-turn on disk with no live run means the server died. Mark
 * it interrupted and close the tool parts its last assistant message left open,
 * so the client renders a finished turn instead of a spinner that never
 * resolves.
 *
 * `awaiting-approval` / `awaiting-input` are resting states waiting on the
 * human, and whether they survive depends on what is left of the turn. On a
 * *stateless* engine (`EngineFactory.statelessTurns`) the whole turn is in the
 * stored messages, so the thread is left untouched and the client's answer
 * still lands. On a stateful one it survives only if the previous process shut
 * down gracefully and froze it: its harness file then carries a `continueFrom`
 * naming a runtime that is still up, and the next turn attaches to it. Without
 * that the turn died with its process, and leaving the approval open would only
 * let the client answer something that is gone — it is closed like the rest.
 * A `running` thread is interrupted either way: its turn was mid-flight.
 */
export async function recoverInterruptedThreads(threads: ThreadStore, registry: EngineRegistry, log: Logger = silentLogger): Promise<void> {
  const stateless = statelessEngines(registry);
  const summaries = await threads.list();
  for (const summary of summaries) {
    const accepted = summary.queue?.filter((item) => item.accepted || item.delivering || item.promoting) ?? [];
    if (accepted.length > 0 && !UNFINISHED_STATUSES.includes(summary.status)) {
      const record = await threads.get(summary.id);
      if (record != null) {
        await threads
          .update(summary.id, {
            queue:
              summary.status === "idle"
                ? record.queue
                    ?.filter((item) => item.claimed === true || item.accepted !== true)
                    .map((item) => ({ ...item, accepted: false, claimed: false, delivering: false, promoting: false }))
                : record.queue?.filter(item => !item.applied).map(item => ({ ...item, accepted: false, delivering: false, promoting: false })),
          })
          .catch((error) => log.warn(`恢复线程 ${summary.id} 的待处理引导失败`, error));
      }
    }
    if (!UNFINISHED_STATUSES.includes(summary.status)) continue;
    if (summary.status !== "running" && stateless.has(summary.engine)) continue;
    if (summary.status !== "running" && (await threads.loadHarnessState(summary.id).catch(() => undefined))?.continueFrom != null) {
      log.info(`线程 ${summary.id} 的未完成轮次已挂起，等待续跑`);
      continue;
    }
    const record = await threads.get(summary.id);
    if (record == null) continue;
    await threads
      .update(summary.id, {
        messages: withTurnEnd(
          closePendingToolParts(
            record.messages.map((message) => {
              const metadata = message.metadata as ThreadMessageMetadata | undefined;
              return metadata?.run?.stopReason === "running"
                ? {
                    ...message,
                    metadata: { ...metadata, run: { ...metadata.run, stopReason: "unknown", endedAt: new Date().toISOString() } },
                  }
                : message;
            }),
            RESTART_PENDING_TOOL_TEXT,
          ),
          { status: "interrupted", reason: RESTART_INTERRUPT_TEXT },
        ),
        queue: record.queue
          ?.filter(
            (item) =>
              !item.applied && !record.messages.some(
                (message) =>
                  message.id === item.id ||
                  (item.mode !== "steer" && message.parts.some((part) => part.type === "data-steer" && (part as { id?: string }).id === item.id)),
              ),
          )
          .map((item) => ({ ...item, accepted: false, delivering: false, promoting: false, claimed: false })),
        status: "interrupted",
        error: RESTART_INTERRUPT_TEXT,
      })
      .catch((error) => log.warn(`恢复线程 ${summary.id} 失败`, error));
  }
}

/**
 * Close every tool part the history left hanging. Terminal parts are untouched,
 * so this is idempotent and does not care where the open turn sits — the
 * abandoning prompt is already appended after it by the time this runs.
 */
export function closePendingToolParts(messages: readonly UIMessage[], errorText: string): UIMessage[] {
  return messages.map((message) => (message.role === "assistant" ? closeOpenToolParts(message, errorText) : message));
}

function closeOpenToolParts(message: UIMessage, errorText: string): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      if (part.state === "output-available" || part.state === "output-error" || part.state === "output-denied") return part;
      return toClosedToolPart(part, errorText);
    }),
  };
}

/**
 * The `output-error` rebuild of an open tool part. The union's `output-error`
 * variant forbids the fields the open states carry (`approval`, `output`), so
 * those are taken off before the rest is kept. Dropping `approval` is
 * deliberate: it also stops `convertToModelMessages` from emitting a stale
 * `tool-approval-response` the next engine session could not resolve. What
 * stays is what every state shares — above all a `dynamic-tool`'s `toolName`,
 * without which the client cannot even name the step.
 */
function toClosedToolPart<T extends AnyToolUIPart>(part: T, errorText: string): T {
  const { state: _state, input, output: _output, errorText: _errorText, approval: _approval, ...shared } = part;
  return { ...shared, state: "output-error", input: input ?? {}, errorText } as unknown as T;
}

/**
 * A tool called with no arguments can come back from an engine with no `input`
 * at all. The SDK's reader stores the part that way, and its own validator then
 * rejects every later request carrying that history — the task can never take
 * another message. No input is an empty one. Only `input-streaming` may lack it.
 */
export function withToolInputs(messages: UIMessage[]): UIMessage[] {
  if (!messages.some(hasPartLackingInput)) return messages;
  return messages.map((message) =>
    hasPartLackingInput(message)
      ? { ...message, parts: message.parts.map((part) => (lacksInput(part) ? { ...part, input: {} } : part)) }
      : message,
  );
}

// Also run on a request body before validation, so nothing here trusts its shape.
const hasPartLackingInput = (message: UIMessage): boolean => Array.isArray(message?.parts) && message.parts.some(lacksInput);

const lacksInput = (part: UIMessage["parts"][number]): boolean =>
  typeof part?.type === "string" && isToolUIPart(part) && part.state !== "input-streaming" && part.input === undefined;

/** The same repair on the way in, so a new turn never stores such a part. */
function withChunkInput(chunk: UIMessageChunk): UIMessageChunk {
  if ((chunk.type === "tool-input-available" || chunk.type === "tool-input-error") && chunk.input === undefined) {
    return { ...chunk, input: {} };
  }
  return chunk;
}

/**
 * Where a history failed validation, as a short suffix for the error: which
 * message and which part. The SDK's own error dumps the entire history.
 */
async function locateInvalid(messages: unknown): Promise<string> {
  if (!Array.isArray(messages)) return "";
  for (const [index, message] of (messages as unknown[]).entries()) {
    if ((await safeValidateUIMessages({ messages: [message] })).success) continue;
    const parts: unknown[] = Array.isArray((message as { parts?: unknown })?.parts) ? (message as { parts: unknown[] }).parts : [];
    for (const part of parts) {
      if ((await safeValidateUIMessages({ messages: [{ ...(message as object), parts: [part] }] })).success) continue;
      const type = (part as { type?: unknown })?.type;
      return `：第 ${index + 1} 条消息的 ${typeof type === "string" ? type : "未知"} 一步`;
    }
    return `：第 ${index + 1} 条消息`;
  }
  return "";
}

/**
 * Lift every half-streamed tool part out of a continuation seed. The message is
 * copied, never mutated — the stored history keeps the parts as they were until
 * the turn ends and decides what to do with them.
 */
function dropStreamingToolParts(message: UIMessage): { message: UIMessage; dropped: DroppedToolPart[] } {
  const dropped: DroppedToolPart[] = [];
  const parts: UIMessage["parts"] = [];
  for (const part of message.parts) {
    if (isToolUIPart(part) && part.state === "input-streaming") dropped.push({ index: parts.length, part });
    else parts.push(part);
  }
  return dropped.length === 0 ? { message, dropped } : { message: { ...message, parts }, dropped };
}

/**
 * Close what a finished turn left half-streamed: the calls whose input the
 * engine never finished sending, plus the ones dropped from the continuation
 * seed that it never re-issued (what a denied approval looks like). Anything the
 * continuation did re-issue is already in the message and is left alone.
 */
function settleStreamingToolParts(message: UIMessage | undefined, dropped: readonly DroppedToolPart[] = []): UIMessage | undefined {
  if (message == null) return message;
  const parts = message.parts.map((part) =>
    isToolUIPart(part) && part.state === "input-streaming" ? toClosedToolPart(part, UNEXECUTED_TOOL_TEXT) : part,
  );
  // Ascending by index, so each reinsertion restores the offset for the next.
  for (const { index, part } of dropped) {
    if (parts.some((existing) => isToolUIPart(existing) && existing.toolCallId === part.toolCallId)) continue;
    parts.splice(Math.min(index, parts.length), 0, toClosedToolPart(part, UNEXECUTED_TOOL_TEXT));
  }
  return { ...message, parts };
}
