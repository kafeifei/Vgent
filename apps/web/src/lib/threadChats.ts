import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatRequestOptions, type FileUIPart, type UIMessage, type UIMessageChunk } from "ai";
import { ApiError, TURN_START_CANCELLED, api, authHeaders, reportUnauthorized } from "./api";
import { shouldSendAutomatically } from "./autoSend";
import { withResumePrelude } from "./resumeChunks";
import type { ThreadRecord, ThreadStatus, ThreadSummary } from "./types";
import { LIVE_STATUSES } from "./types";

/**
 * How often a streaming chat may re-render, for every `useChat` on a shared
 * `Chat`. Unthrottled, each chunk is its own synchronous commit; a replay on
 * opening a running task delivers hundreds in one go, and React gives up past
 * fifty nested updates (error 185).
 */
export const CHAT_THROTTLE_MS = 50;

const isLive = (status: ThreadStatus): boolean => (LIVE_STATUSES as readonly string[]).includes(status);

/**
 * The AI SDK's transport turns a non-OK chat response into an `APICallError`
 * whose `message` is the raw response body — for our `{ error: { code,
 * message } }` envelope (e.g. 503 `engine_unavailable`), that is the JSON
 * text itself. Unwrap it so the toast and the log's error bar show the
 * server's Chinese message instead of raw JSON.
 */
export function transportErrorText(message: string): string {
  try {
    const body = JSON.parse(message) as { error?: { message?: string } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not JSON — a network failure, abort, etc. Keep the original message.
  }
  return message;
}

function describeTransportError(error: Error): Error {
  const text = transportErrorText(error.message);
  return text === error.message ? error : new Error(text);
}

/**
 * The 409 the server answers a message with when 停止 got to the turn before it
 * was a run: as an `ApiError` carrying its code, or `undefined` for any other
 * response. Read from a clone, so the SDK can still read the original.
 */
async function startCancellation(response: Response): Promise<ApiError | undefined> {
  if (response.status !== 409) return undefined;
  const body = (await response.clone().json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (body?.error?.code !== TURN_START_CANCELLED) return undefined;
  return new ApiError(body.error.message ?? "回合还没开始就被停止了，这条消息没有发出", 409, TURN_START_CANCELLED);
}

/**
 * What the transport throws for a start that 停止 cancelled: an abort, as far as
 * the SDK is concerned. `Chat.makeRequest` takes any error named `AbortError` as
 * the request being stopped — back to `ready`, no `onError` — and returns before
 * it checks `sendAutomaticallyWhen`. A request that failed any other way would
 * be reported, and one that ended any other quiet way (an empty stream) would be
 * followed by that check, which an approval answer or a tool result still
 * satisfies: the SDK would post the continuation again, undoing the stop.
 */
const cancelledStart = (): DOMException => new DOMException("The turn was stopped before it started", "AbortError");

/**
 * `DefaultChatTransport` plus the repair a replayed stream needs before the
 * SDK's blank resume state can apply it — see `withResumePrelude`.
 */
class ResumableTransport extends DefaultChatTransport<UIMessage> {
  constructor(
    options: ConstructorParameters<typeof DefaultChatTransport<UIMessage>>[0],
    private readonly resumed: () => UIMessage | undefined,
  ) {
    super(options);
  }

  override async reconnectToStream(
    options: { chatId: string; abortSignal?: AbortSignal } & ChatRequestOptions,
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const stream = await super.reconnectToStream(options);
    return stream == null ? null : withResumePrelude(stream, this.resumed());
  }
}

/**
 * One official `Chat` per thread id, ported from freecode's `TaskChats`.
 *
 * The server owns exactly one chunk stream per assistant turn, so this registry
 * only has to (a) load the snapshot a turn started from and (b) attach to that
 * stream. Everything else — transport, approvals, tool outputs — stays with
 * `useChat`, which takes the very `Chat` instance held here.
 *
 * There is no rollback: the server has no route for it.
 *
 * Only the task on screen keeps its stream open. The page reaches the server
 * over HTTP/1.1, which allows six connections per host — `/api/state` takes
 * one, and a stream per running task took the rest: with five tasks running,
 * every other request queued behind them and the next task opened stayed on
 * 「加载中…」 forever. A task left while its turn runs lets go of its stream;
 * the run itself lives on the server and is joined again on return.
 */
export class ThreadChats {
  private readonly chats = new Map<string, Chat<UIMessage>>();
  /** Resolves once a chat's persisted history has been loaded into it. */
  private readonly ready = new Map<string, Promise<void>>();
  private readonly resuming = new Set<string>();
  private readonly latest = new Map<string, ThreadSummary>();
  /** `updatedAt` of the record each chat's messages were last loaded from. */
  private readonly hydratedAt = new Map<string, string>();
  /**
   * 发出去了没有: one waiter per in-flight `send`, settled by the chat POST's own
   * response. Only that first response decides — a turn that fails later really
   * did leave the composer.
   */
  private readonly accepting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  /** The task on screen: the one chat allowed to hold a stream open. */
  private focused: string | null = null;
  /**
   * Chats let go of mid-turn. Their messages stop wherever the stream was cut,
   * so they must not auto-send off that partial state, nor be read as current.
   */
  private readonly detached = new Set<string>();
  /**
   * `updatedAt` at which `GET /stream` last found nothing to join (a 204 — a
   * task waiting on the human has no stream). Asking again at the same
   * `updatedAt` gets the same answer, so a snapshot that changed nothing about
   * the task does not send the chat back to the server.
   */
  private readonly idleAt = new Map<string, string>();
  /** Threads whose resume request just answered 204; read once the resume returns. */
  private readonly noStream = new Set<string>();
  /** Bumped by `dispose()`; every in-flight promise checks it before writing. */
  private generation = 0;

  constructor(
    private readonly token: string,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  /** The chat for a thread, created and hydrated on first use. */
  get(threadId: string): Chat<UIMessage> {
    const current = this.chats.get(threadId);
    if (current != null) return current;

    const chat = this.build(threadId);
    this.chats.set(threadId, chat);
    const loading = this.load(threadId, chat)
      .catch((error: unknown) => {
        if (this.chats.get(threadId) === chat && error instanceof Error) this.onError(error);
      })
      .finally(() => {
        if (this.ready.get(threadId) === loading) this.ready.delete(threadId);
      });
    this.ready.set(threadId, loading);
    return chat;
  }

  /**
   * The chat of the task on screen, or nothing — unlike `get`, this never
   * creates one. A chat off screen is not following its turn, so what it holds
   * is not what the task is doing now.
   */
  peek(threadId: string): Chat<UIMessage> | undefined {
    return threadId === this.focused ? this.chats.get(threadId) : undefined;
  }

  /**
   * The task now on screen, or none. The one before lets go of its stream; this
   * one joins its turn if it is live, with a fresh history first when it was let
   * go of mid-turn — `whenReady` waits for that, so call this before it.
   */
  focus(threadId: string | null): void {
    if (this.focused === threadId) return;
    const previous = this.focused;
    this.focused = threadId;
    if (previous != null) this.detach(previous);
    const summary = threadId == null ? undefined : this.latest.get(threadId);
    if (summary != null) this.reconcile(summary);
  }

  /** Awaits the initial history load, so a view never renders a half-filled chat. */
  whenReady(threadId: string): Promise<void> {
    this.get(threadId);
    return this.ready.get(threadId) ?? Promise.resolve();
  }

  private build(threadId: string): Chat<UIMessage> {
    const generation = this.generation;
    const headers = authHeaders(this.token);
    const transport = new ResumableTransport(
      {
        api: `/api/chat/${threadId}`,
        headers,
        prepareReconnectToStreamRequest: ({ id }) => ({ api: `/api/chat/${id}/stream`, headers }),
        // The chat routes bypass `api()`, so they report a rejected token here —
        // and this is also where a `send` learns whether the server took the
        // message at all. A GET is the resume, which decides nothing.
        fetch: async (input, init) => {
          const isSend = (init?.method ?? "GET").toUpperCase() === "POST";
          let response: Response;
          try {
            response = await fetch(input, init);
          } catch (error) {
            if (isSend) this.settleAccept(threadId, error instanceof Error ? error : new Error(String(error)));
            throw error;
          }
          if (response.status === 401) reportUnauthorized();
          if (isSend) {
            // 停止 came before the turn was a run: the message did not go out and
            // nothing was written. The sender is told (so the text stays in the
            // box), but it is no error — the SDK is handed an abort, which ends
            // without an error state, an error bar, a toast, or another try.
            const cancelled = await startCancellation(response);
            if (cancelled != null) {
              this.settleAccept(threadId, cancelled);
              throw cancelledStart();
            }
            this.settleAccept(threadId, response.ok ? undefined : new Error(`${response.status}`));
          } else if (response.status === 204) this.noStream.add(threadId);
          return response;
        },
      },
      // The message a replayed continuation stream addresses: the one this
      // client loaded from `/threads/:id` before the resume was allowed to run.
      () => {
        const last = this.chats.get(threadId)?.messages.at(-1);
        return last?.role === "assistant" ? last : undefined;
      },
    );
    return new Chat<UIMessage>({
      id: threadId,
      messages: [],
      transport,
      // This belongs on the `Chat`, not on `useChat`: when `useChat` is handed
      // an existing instance it ignores every other `ChatInit` field, so an
      // approval answered in the UI would never be posted back. A chat cut off
      // mid-turn still ends its request, and must not post its partial state.
      sendAutomaticallyWhen: (options) => !this.detached.has(threadId) && shouldSendAutomatically(options),
      onError: (error) => {
        if (generation !== this.generation) return;
        this.onError(describeTransportError(error));
      },
    });
  }

  private history(threadId: string): Promise<ThreadRecord> {
    return api<ThreadRecord>(`/threads/${threadId}`, this.token);
  }

  /**
   * The history a joining client needs, and only then the live stream.
   *
   * The order is the whole point: a resume replays chunks that address parts of
   * the message this load puts in place, so it must never start first. That is
   * also why `useChat` is *not* given `resume: true` — its own mount effect
   * fires the resume in parallel with this load.
   */
  private async load(threadId: string, chat: Chat<UIMessage>): Promise<void> {
    const generation = this.generation;
    const record = await this.history(threadId);
    if (generation !== this.generation || this.chats.get(threadId) !== chat) return;
    this.hydrate(threadId, chat, record);
    // Kicked off, not awaited: `whenReady` must resolve with the history, or
    // the view sits on its spinner for as long as the resumed turn runs.
    // `resume` marks `resuming` synchronously, so the guards still hold.
    if (isLive(this.latest.get(threadId)?.status ?? "idle")) void this.resume(threadId);
  }

  private hydrate(threadId: string, chat: Chat<UIMessage>, record: ThreadRecord): void {
    chat.messages = record.messages;
    this.hydratedAt.set(threadId, record.updatedAt);
    this.detached.delete(threadId);
  }

  /**
   * Called with every `/api/state` snapshot. The live thread on screen gets
   * re-attached to its stream; a finished one gets its snapshot refreshed
   * whenever the server has touched the record since we last read it (a turn
   * that ended in an error leaves the counts equal and the content different).
   */
  observeThreads(summaries: readonly ThreadSummary[]): void {
    for (const summary of summaries) {
      this.latest.set(summary.id, summary);
      this.reconcile(summary);
    }
  }

  private reconcile(summary: ThreadSummary): void {
    const chat = this.chats.get(summary.id);
    if (chat == null) return;

    if (isLive(summary.status)) {
      // Off screen, a live chat holds no stream: the run goes on without it.
      if (summary.id !== this.focused) {
        this.detach(summary.id);
        return;
      }
      // `ready` still held means the history is in flight; that load starts
      // the resume itself once the messages are in.
      if (this.resuming.has(summary.id) || this.ready.has(summary.id)) return;
      if (chat.status === "error") chat.clearError();
      // A settled chat on a live thread means this client is not following the
      // turn: another window or the server's own 排队 dispatcher started it, or
      // this chat let go of it off screen. The record holds what this chat does
      // not, so the history has to come first — see `attach`. Not again for an
      // `updatedAt` the stream endpoint already answered 204 for.
      if (chat.status === "ready" && this.idleAt.get(summary.id) !== summary.updatedAt) void this.attach(summary, chat);
      return;
    }

    this.idleAt.delete(summary.id);
    if (chat.status === "error") chat.clearError();
    this.refreshIfStale(summary, chat);
  }

  /**
   * Lets go of a chat's stream without stopping its run, which the server owns;
   * `attach` picks the turn up again.
   *
   * A request not yet answered is left alone unless `accepted` says the server
   * has it: cut too early, an approval answer would never arrive. `send` lets
   * go once it knows; an automatic send is let go of by the next snapshot.
   */
  private detach(threadId: string, accepted = false): void {
    // Back on screen, it asks again once: the 204 was about the task as it was then.
    this.idleAt.delete(threadId);
    const chat = this.chats.get(threadId);
    if (chat == null || this.accepting.has(threadId)) return;
    const holding = this.resuming.has(threadId) || chat.status === "streaming" || (accepted && chat.status === "submitted");
    if (!holding) return;
    this.detached.add(threadId);
    // What it holds stops mid-turn, so the next attach must read the record.
    this.hydratedAt.delete(threadId);
    void chat.stop().catch(() => undefined);
  }

  /** Snapshot refresh for a thread that is no longer streaming. */
  private refreshIfStale(summary: ThreadSummary, chat: Chat<UIMessage>): void {
    // `ready` also guards an optimistic user message: `send` leaves the chat
    // submitted/streaming, and only a settled chat may be replaced wholesale.
    if (chat.status !== "ready") return;
    if (this.resuming.has(summary.id) || this.ready.has(summary.id)) return;
    if (this.hydratedAt.get(summary.id) === summary.updatedAt) return;
    const generation = this.generation;
    const pending = this.history(summary.id)
      .then((record) => {
        if (generation !== this.generation || this.chats.get(summary.id) !== chat) return;
        if (chat.status !== "ready" || this.resuming.has(summary.id)) return;
        this.hydrate(summary.id, chat, record);
      })
      .catch((error: unknown) => {
        if (error instanceof Error) this.onError(error);
      })
      .finally(() => {
        if (this.ready.get(summary.id) === pending) this.ready.delete(summary.id);
      });
    // Parked in `ready` so a concurrent observe/resume does not race it.
    this.ready.set(summary.id, pending);
  }

  /**
   * Join a turn this client did not start: the history the server wrote when it
   * began, and only then the stream.
   *
   * Without the reload the user message the server appended by itself — 排队's
   * whole point — would be missing, and the replayed chunks would address an
   * assistant message that is not in this chat either. The load is parked in
   * `ready` so a concurrent snapshot does not race it, exactly like
   * `refreshIfStale` does.
   */
  private attach(summary: ThreadSummary, chat: Chat<UIMessage>): Promise<void> {
    const generation = this.generation;
    const fresh = this.hydratedAt.get(summary.id) === summary.updatedAt;
    const pending = (fresh ? Promise.resolve(undefined) : this.history(summary.id))
      .then((record) => {
        if (record == null || generation !== this.generation || this.chats.get(summary.id) !== chat) return;
        // Only a settled chat may be replaced wholesale; a resume that slipped
        // in first already owns the message list.
        if (chat.status !== "ready" || this.resuming.has(summary.id)) return;
        this.hydrate(summary.id, chat, record);
      })
      .catch((error: unknown) => {
        if (error instanceof Error) this.onError(error);
      })
      .finally(() => {
        if (this.ready.get(summary.id) === pending) this.ready.delete(summary.id);
      });
    this.ready.set(summary.id, pending);
    return pending.then(() => this.resume(summary.id));
  }

  /** Attach to the thread's active run. An idle thread answers 204 and resolves. */
  private async resume(threadId: string): Promise<void> {
    const chat = this.chats.get(threadId);
    if (chat == null || this.resuming.has(threadId) || threadId !== this.focused) return;
    const generation = this.generation;
    // The answer is about the task as the snapshot showed it when the request left.
    const asked = this.latest.get(threadId)?.updatedAt;
    this.resuming.add(threadId);
    this.noStream.delete(threadId);
    try {
      await chat.resumeStream();
    } catch (error) {
      if (generation === this.generation && error instanceof Error) this.onError(error);
    } finally {
      if (generation === this.generation) {
        this.resuming.delete(threadId);
        // 204: nothing to join. A stream that ran and ended, or dropped, is not
        // recorded — the next snapshot may attach again, as before.
        if (this.noStream.delete(threadId) && asked != null && this.chats.get(threadId) === chat) this.idleAt.set(threadId, asked);
      }
    }
  }

  /** Settles the waiter a `send` is holding, if there is one. */
  private settleAccept(threadId: string, error?: Error): void {
    const waiter = this.accepting.get(threadId);
    if (waiter == null) return;
    this.accepting.delete(threadId);
    if (error == null) waiter.resolve();
    else waiter.reject(error);
  }

  /**
   * 发送失败不吞草稿: resolves once the server has *accepted* the message, and
   * rejects when it refused it (409 运行中, 503 引擎不可用, a dead connection).
   * The caller clears the composer on the first and puts the text back on the
   * second.
   *
   * `sendMessage` itself only settles when the whole turn is over, and reports
   * its failures through `onError` rather than by throwing, so acceptance is
   * taken from the POST's own response — see the transport's `fetch` above.
   */
  async send(threadId: string, text: string, files: FileUIPart[] = []): Promise<void> {
    const chat = this.get(threadId);
    await this.whenReady(threadId);
    const before = chat.messages;
    const accepted = new Promise<void>((resolve, reject) => {
      this.accepting.set(threadId, { resolve, reject });
    });
    // Not awaited: it runs for as long as the turn does. Its outcome is only a
    // backstop for a request that never reached `fetch` at all.
    // 附件 ride along as `file` parts; a message may be nothing but them.
    void chat.sendMessage(files.length === 0 ? { text } : text === "" ? { files } : { text, files }).then(
      () => this.settleAccept(threadId),
      (error: unknown) => this.settleAccept(threadId, error instanceof Error ? error : new Error(String(error))),
    );
    try {
      await accepted;
    } catch (error) {
      // The optimistic user message must not stay in the log: it never went out.
      if (this.chats.get(threadId) === chat) chat.messages = before;
      throw error;
    }
    // Sent from a task already left — say a new one whose worktree took a
    // while: the server has the turn now, and this stream has no one to show it to.
    if (threadId !== this.focused) this.detach(threadId, true);
  }

  /** Client-side abort plus the server-side stop the abort alone cannot do. */
  async stop(threadId: string): Promise<void> {
    const chat = this.chats.get(threadId);
    await chat?.stop().catch(() => undefined);
    await api<void>(`/chat/${threadId}/stop`, this.token, { method: "POST" }).catch(() => undefined);
  }

  /** Drops a thread's chat, e.g. after it is deleted server-side. */
  forget(threadId: string): void {
    this.settleAccept(threadId, new Error("任务已删除"));
    this.chats.delete(threadId);
    this.ready.delete(threadId);
    this.resuming.delete(threadId);
    this.latest.delete(threadId);
    this.hydratedAt.delete(threadId);
    this.detached.delete(threadId);
    this.idleAt.delete(threadId);
    this.noStream.delete(threadId);
  }

  dispose(): void {
    this.generation += 1;
    for (const threadId of [...this.accepting.keys()]) this.settleAccept(threadId, new Error("已断开"));
    for (const chat of this.chats.values()) void chat.stop().catch(() => undefined);
    this.chats.clear();
    this.ready.clear();
    this.resuming.clear();
    this.latest.clear();
    this.hydratedAt.clear();
    this.detached.clear();
    this.idleAt.clear();
    this.noStream.clear();
    this.focused = null;
  }
}
