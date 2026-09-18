import { randomUUID } from "node:crypto";
import { getHarnessErrorMessage } from "@ai-sdk/harness/agent";
import {
  convertToModelMessages,
  isToolUIPart,
  readUIMessageStream,
  toUIMessageStream,
  validateUIMessages,
  type DynamicToolUIPart,
  type LanguageModelUsage,
  type ToolUIPart,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import type { ChunkHub } from "./chunk-hub.js";
import { createChunkHub } from "./chunk-hub.js";
import { BadRequestError, ConflictError, NotFoundError, TurnResumeFailedError, VgentServerError } from "./errors.js";
import { effectivePermission } from "./engines/capabilities.js";
import type { EngineRegistry, EngineRunner } from "./engines/registry.js";
import { statelessEngines } from "./engines/registry.js";
import type { ProjectStore } from "./store/projects.js";
import type { SettingsStore } from "./store/settings.js";
import { DEFAULT_THREAD_TITLE, type ThreadStore } from "./store/threads.js";
import type { ChangeStats, Logger, ThreadMessageMetadata, ThreadRecord, ThreadStatus, UsageInfo } from "./types.js";
import { silentLogger } from "./types.js";
import { whenSetupSettled } from "./worktree-setup.js";

/** Mid-turn persists are at least this far apart; the final one always lands. */
const PERSIST_INTERVAL_MS = 1000;

/** How long `stop()` waits for a run to wind down before it forces the slot open. */
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/** Cap on the raw error text persisted to a thread record. */
const RAW_ERROR_TEXT_MAX_LEN = 2000;

/**
 * The unmasked error text for a thread record. `getHarnessErrorMessage`
 * (used as `toUIMessageStream`'s `onError`) produces a client-safe string —
 * right for the SSE stream, but the thread record is local single-user data,
 * so it keeps the real message for debugging and later display.
 */
function rawErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, RAW_ERROR_TEXT_MAX_LEN);
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
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  return {
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens } : {}),
    ...(cached != null ? { cachedInputTokens: cached } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
  };
}

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
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0)?.trim();
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
}

/** A runner kept alive between requests because its turn is waiting on the human. */
interface ParkedEngine {
  runner: EngineRunner;
  /** Its engine's `statelessTurns`: whether the pending answer outlives this process. */
  stateless: boolean;
}

export interface RunManager {
  start(threadId: string, uiMessages: unknown): Promise<ChunkHub>;
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
}): RunManager {
  const { threads, projects, settings, registry, dataDir } = options;
  const log = options.log ?? silentLogger;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const runs = new Map<string, LiveRun>();
  /**
   * A finished run releases its slot before it stops its engine, so a crash in
   * cleanup can never wedge a thread. The next turn still has to wait for that
   * cleanup, or it would start from stale resume state.
   */
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
    const content = assistant.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
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

  const runTurn = async (thread: ThreadRecord, incoming: UIMessage[], run: LiveRun): Promise<void> => {
    const stored = await projects.get(thread.projectId);
    if (stored == null) throw new NotFoundError(`项目不存在: ${thread.projectId}`, "project_not_found");
    // A worktree task sees its own directory as the repo. Nothing below the
    // engine factories knows the difference — they all read `repoPath` only.
    const project = thread.workspace != null ? { ...stored, repoPath: thread.workspace.path } : stored;

    const factory = registry[thread.engine];
    if (factory == null) throw new BadRequestError(`未知引擎: ${thread.engine}`, "unknown_engine");

    let messages = incoming;
    let runner: EngineRunner | undefined;
    let assistant: UIMessage | undefined;
    let lastPersistedAt = 0;
    /** Set from the first `error` chunk the engine stream produced, if any. */
    let streamError: string | undefined;
    /** The same error's raw, unmasked message — for the persisted thread record. */
    let rawStreamError: string | undefined;
    let park = false;

    /**
     * The history with this turn's assistant message folded in — or unchanged
     * when the turn produced nothing renderable. A turn that only errors out
     * still yields a message from `readUIMessageStream`, and storing that empty
     * shell leaves the thread with an assistant bubble that renders nothing,
     * converts to nothing, and confuses every later read of the history.
     */
    const withAssistant = (message: UIMessage | undefined): UIMessage[] =>
      message != null && message.parts.length > 0 ? mergeIncoming(messages, [message]) : messages;

    const persist = async (message: UIMessage) => {
      if (message.parts.length === 0) return;
      await threads.saveMessages(thread.id, mergeIncoming(messages, [message]));
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

    try {
      let modelMessages = await convertToModelMessages(messages);
      // The harness itself decides "continue the open turn" vs "start a new
      // one" by whether the last model message is `role: 'tool'` (approval
      // responses / tool results), so the run manager reads it the same way.
      const continuesTurn = modelMessages.at(-1)?.role === "tool";
      const parkedRunner = parked.get(thread.id)?.runner;

      if (parkedRunner != null && continuesTurn) {
        parked.delete(thread.id);
        runner = parkedRunner;
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
          await clearContinueFrom(thread.id);
          messages = closePendingToolParts(messages, ABANDONED_TURN_TEXT);
          modelMessages = await convertToModelMessages(messages);
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
          saveHarnessState: (state) => threads.saveHarnessState(thread.id, state),
          log,
        });
      }

      // A runner with its own in-process tools has to convert the history with
      // them: `toModelOutput` is what turns a stored subagent transcript back
      // into the summary the model actually saw, and it only runs here. The
      // first conversion above cannot do it — the runner does not exist yet,
      // and picking it needs `continuesTurn`, which needs the conversion.
      if (runner.tools != null) modelMessages = await convertToModelMessages(messages, { tools: runner.tools });

      const result = await runner.stream({ messages: modelMessages, abortSignal: run.abort.signal });

      const uiStream = toUIMessageStream({
        stream: result.stream,
        originalMessages: messages,
        generateMessageId: () => randomUUID(),
        // Called with the raw error of every `error` chunk the engine stream
        // produces. The masked text goes to the client; the raw text is kept
        // for the thread record below.
        onError: (error) => {
          rawStreamError ??= rawErrorText(error);
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
        messageMetadata: ({ part }): ThreadMessageMetadata | undefined => {
          if (part.type === "finish-step") return { usage: toUsageInfo(part.usage) };
          if (part.type === "finish") return { totalUsage: toUsageInfo(part.totalUsage) };
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
        run.hub.publish(value);
      }
      run.hub.close();
      await reader;

      const status = streamError != null ? "error" : deriveStatus(assistant);
      park = !run.stopped && (status === "awaiting-approval" || status === "awaiting-input");
      // A turn that is over has nothing left that could finish a half-streamed
      // call: either the engine re-issued it in a later step, or it never will
      // (a denied approval ends the turn on the spot). A parked turn keeps its
      // open parts — its step is still running inside the engine.
      const settled = park || run.stopped ? assistant : settleStreamingToolParts(assistant, seed?.dropped);

      if (!run.stopped) {
        const stats = await measureChanges(thread);
        // 计划回合的最终回复就是计划文档。Only a turn that really ended writes it:
        // one parked on a question is still mid-research, and an interrupted or
        // failed one has no plan to speak of.
        if (thread.mode === "plan" && status === "idle") await savePlanFrom(thread.id, settled);
        await threads
          .update(thread.id, {
            messages: withAssistant(settled),
            status,
            error: rawStreamError ?? streamError,
            ...(stats != null ? { changeStats: stats } : {}),
          })
          .catch(async (error) => {
            // Never let a failed final write leave the thread stuck `running`.
            log.error(`保存线程 ${thread.id} 的最终状态失败`, error);
            park = false;
            await threads
              .update(thread.id, { status: "error", error: getHarnessErrorMessage(error) })
              .catch((fallback) => log.error(`记录线程 ${thread.id} 的错误状态也失败`, fallback));
          });
      } else if (assistant != null && assistant.parts.length > 0) {
        await threads.update(thread.id, { messages: withAssistant(settled) });
      }
    } catch (error) {
      park = false;
      // The frozen turn is gone. That is not an engine failure to report as
      // one: the thread settles into the same interrupted shape a hard restart
      // leaves behind, with every pending call closed, so the client stops
      // offering to answer a turn nobody holds any more.
      const resumeFailed = error instanceof TurnResumeFailedError;
      if (resumeFailed) await clearContinueFrom(thread.id);
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
      await threads
        .update(thread.id, {
          messages: resumeFailed
            ? closePendingToolParts(withAssistant(assistant), RESUME_FAILED_TEXT)
            : withAssistant(run.stopped ? assistant : settleStreamingToolParts(assistant, seed?.dropped)),
          status: run.stopped || resumeFailed ? "interrupted" : "error",
          ...(run.stopped ? {} : { error: rawMessage }),
        })
        .catch((updateError) => log.error(`记录线程 ${thread.id} 的错误状态失败`, updateError));
    } finally {
      // Release the slot first: whatever happens to the engine, the thread must
      // be startable again.
      runs.delete(thread.id);
      run.hub.close();
      if (runner != null) {
        if (park && !run.stopped) {
          // Alive on purpose, and no harness file is written: `<id>.harness.json`
          // must keep the last *finished* turn's state.
          parked.set(thread.id, { runner, stateless: factory.statelessTurns === true });
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
    }
  };

  return {
    async start(threadId, uiMessages) {
      const thread = await threads.get(threadId);
      if (thread == null) throw new NotFoundError(`线程不存在: ${threadId}`, "thread_not_found");
      if (thread.workspace?.reclaimed === true) {
        throw new ConflictError("此任务的工作目录已回收，请先恢复后再运行", "workspace_reclaimed");
      }
      const active = runs.get(threadId);
      if (active != null) {
        if (!active.hub.closed) throw new ConflictError(`线程已在运行: ${threadId}`, "thread_running");
        // The turn is over — the client saw the stream close — and the run is
        // only finishing its bookkeeping. Answering an approval that fast is
        // normal, so wait for the slot instead of rejecting it.
        await active.done.catch(() => {});
      }
      // A fresh worktree may still be installing dependencies: the user could
      // submit their first message the moment the task appeared. A *failed*
      // setup does not hold the turn back — the task simply runs without it.
      await whenSetupSettled(threadId);
      const factory = registry[thread.engine];
      if (factory == null) throw new BadRequestError(`未知引擎: ${thread.engine}`, "unknown_engine");
      // Awaited: the probe can touch the filesystem (a login store, an
      // environment credential), and a rejected precondition has to become the
      // HTTP response instead of an unhandled rejection.
      await factory.ensureAvailable?.({ thread });
      // The previous turn's engine may still be persisting its resume state.
      await finishing.get(threadId);

      let validated: UIMessage[];
      try {
        validated = await validateUIMessages({ messages: uiMessages });
      } catch (error) {
        throw new BadRequestError(`消息格式不合法: ${error instanceof Error ? error.message : String(error)}`, "invalid_messages");
      }
      if (validated.length === 0) throw new BadRequestError("消息为空", "invalid_messages");

      const messages = mergeIncoming(thread.messages, validated);
      // A thread is named by its first user message; an explicit title is kept.
      const title = thread.title === DEFAULT_THREAD_TITLE ? deriveThreadTitle(messages) : undefined;
      const updated = await threads.update(threadId, {
        messages,
        status: "running",
        error: undefined,
        // The task is working again, so whatever it was wound up as no longer
        // describes what is on disk.
        outcome: undefined,
        ...(title != null ? { title } : {}),
      });

      const run: LiveRun = { hub: createChunkHub(), abort: new AbortController(), done: Promise.resolve(), stopped: false };
      runs.set(threadId, run);
      // Detached on purpose: an HTTP client disconnecting must not cancel the turn.
      run.done = runTurn(updated, messages, run);
      run.done.catch((error) => log.error(`线程 ${threadId} 的运行崩溃`, error));

      return run.hub;
    },

    async stop(threadId) {
      await releaseParked(threadId, STOP_INTERRUPT_TEXT);
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
        log.warn(`线程 ${threadId} 在 ${stopTimeoutMs}ms 内没有停下，强制释放槽位`);
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
        messages: closePendingToolParts(record.messages, RESTART_PENDING_TOOL_TEXT),
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
 * the closed part is rebuilt, not spread. Dropping `approval` is deliberate: it
 * also stops `convertToModelMessages` from emitting a stale
 * `tool-approval-response` the next engine session could not resolve.
 */
function toClosedToolPart<T extends AnyToolUIPart>(part: T, errorText: string): T {
  return {
    type: part.type,
    toolCallId: part.toolCallId,
    state: "output-error",
    input: part.input,
    errorText,
  } as unknown as T;
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
