import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatRequestOptions, type UIMessage, type UIMessageChunk } from "ai";
import { api, authHeaders, reportUnauthorized } from "./api";
import { shouldSendAutomatically } from "./autoSend";
import { withResumePrelude } from "./resumeChunks";
import type { ThreadRecord, ThreadStatus, ThreadSummary } from "./types";
import { LIVE_STATUSES } from "./types";

const isLive = (status: ThreadStatus): boolean => (LIVE_STATUSES as readonly string[]).includes(status);

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
 */
export class ThreadChats {
  private readonly chats = new Map<string, Chat<UIMessage>>();
  /** Resolves once a chat's persisted history has been loaded into it. */
  private readonly ready = new Map<string, Promise<void>>();
  private readonly resuming = new Set<string>();
  private readonly latest = new Map<string, ThreadSummary>();
  /** `updatedAt` of the record each chat's messages were last loaded from. */
  private readonly hydratedAt = new Map<string, string>();
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
        // The chat routes bypass `api()`, so they report a rejected token here.
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (response.status === 401) reportUnauthorized();
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
      // approval answered in the UI would never be posted back.
      sendAutomaticallyWhen: shouldSendAutomatically,
      onError: (error) => {
        if (generation !== this.generation) return;
        this.onError(error);
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
    chat.messages = record.messages;
    this.hydratedAt.set(threadId, record.updatedAt);
    // Kicked off, not awaited: `whenReady` must resolve with the history, or
    // the view sits on its spinner for as long as the resumed turn runs.
    // `resume` marks `resuming` synchronously, so the guards still hold.
    if (isLive(this.latest.get(threadId)?.status ?? "idle")) void this.resume(threadId);
  }

  /**
   * Called with every `/api/state` snapshot. A live thread gets re-attached to
   * its stream; a finished one gets its snapshot refreshed whenever the server
   * has touched the record since we last read it (a turn that ended in an error
   * leaves the counts equal and the content different).
   */
  observeThreads(summaries: readonly ThreadSummary[]): void {
    for (const summary of summaries) {
      this.latest.set(summary.id, summary);
      const chat = this.chats.get(summary.id);
      if (chat == null) continue;

      if (isLive(summary.status)) {
        // `ready` still held means the history is in flight; that load starts
        // the resume itself once the messages are in.
        if (this.resuming.has(summary.id) || this.ready.has(summary.id)) continue;
        if (chat.status === "error") chat.clearError();
        if (chat.status === "ready") void this.resume(summary.id);
        continue;
      }

      if (chat.status === "error") chat.clearError();
      this.refreshIfStale(summary, chat);
    }
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
        chat.messages = record.messages;
        this.hydratedAt.set(summary.id, record.updatedAt);
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

  /** Attach to the thread's active run. An idle thread answers 204 and resolves. */
  private async resume(threadId: string): Promise<void> {
    const chat = this.chats.get(threadId);
    if (chat == null || this.resuming.has(threadId)) return;
    const generation = this.generation;
    this.resuming.add(threadId);
    try {
      await chat.resumeStream();
    } catch (error) {
      if (generation === this.generation && error instanceof Error) this.onError(error);
    } finally {
      if (generation === this.generation) this.resuming.delete(threadId);
    }
  }

  async send(threadId: string, text: string): Promise<void> {
    const chat = this.get(threadId);
    await this.whenReady(threadId);
    await chat.sendMessage({ text });
  }

  /** Client-side abort plus the server-side stop the abort alone cannot do. */
  async stop(threadId: string): Promise<void> {
    const chat = this.chats.get(threadId);
    await chat?.stop().catch(() => undefined);
    await api<void>(`/chat/${threadId}/stop`, this.token, { method: "POST" }).catch(() => undefined);
  }

  /** Drops a thread's chat, e.g. after it is deleted server-side. */
  forget(threadId: string): void {
    this.chats.delete(threadId);
    this.ready.delete(threadId);
    this.resuming.delete(threadId);
    this.latest.delete(threadId);
    this.hydratedAt.delete(threadId);
  }

  dispose(): void {
    this.generation += 1;
    for (const chat of this.chats.values()) void chat.stop().catch(() => undefined);
    this.chats.clear();
    this.ready.clear();
    this.resuming.clear();
    this.latest.clear();
    this.hydratedAt.clear();
  }
}
