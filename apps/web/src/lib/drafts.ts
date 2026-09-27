import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 草稿任何情况下不丢: what is half-typed in the composer, per task — the text
 * and the files waiting to go out with it.
 *
 * The server owns it (`GET` / `PUT /api/drafts/:key`); `localStorage` is only
 * an instant cache of the text. It has to be the server: the desktop shell
 * starts the backend on a random port, the port is part of the WebView's
 * origin, and per-origin storage is therefore empty on every launch — drafts
 * written in the last session would be unreachable. The attachments are not
 * cached at all: a `data:` URL of a 10 MB file does not fit in `localStorage`,
 * and the server is local, so they arrive a moment after the text.
 *
 * Opening a task paints the cached text at once and then reconciles: the server
 * wins, unless the user has already typed (or touched the files) since this
 * view mounted. Text writes are debounced 300 ms with a 2 s ceiling and flushed
 * on task switch, unmount and `pagehide` / `visibilitychange`; a change to the
 * attachments goes up at once, with the bytes of any file the server has not
 * been sent yet — every later write names that file by id alone.
 */

const PREFIX = "vgent.draft.";

/** The empty state's own draft; it becomes a real task's first message. */
export const NEW_TASK_DRAFT = "new";

/** Keystrokes settle before the draft goes up… */
const DEBOUNCE_MS = 300;
/** …but a long, steady typist still gets a write every two seconds. */
const CEILING_MS = 2000;

const keyOf = (key: string): string => `${PREFIX}${key}`;

/**
 * Every cache access is wrapped: private mode throws on the very first read,
 * and a lost draft must never take the app down with it.
 */
function readCache(key: string): string {
  try {
    return localStorage.getItem(keyOf(key)) ?? "";
  } catch {
    return "";
  }
}

function writeCache(key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(keyOf(key));
    else localStorage.setItem(keyOf(key), value);
  } catch {
    /* private mode, or the quota is full: the in-memory draft still works */
  }
}

/**
 * Drop the *cached* drafts of tasks that no longer exist. The server drops its
 * own copy when the task is deleted; this only keeps the local cache from
 * growing for tasks deleted in another window.
 */
export function pruneDrafts(liveThreadIds: Iterable<string>): void {
  const keep = new Set([...liveThreadIds].map(keyOf));
  keep.add(keyOf(NEW_TASK_DRAFT));
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key != null && key.startsWith(PREFIX) && !keep.has(key)) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** A file waiting in the composer: what the draft keeps, and what the message carries. */
export interface DraftAttachment {
  id: string;
  name: string;
  mediaType: string;
  /** A `data:` URL: what the message carries, and what the thumbnail draws. */
  url: string;
  size: number;
}

/** One attachment on the wire; `url` only the first time the server hears of it. */
export type DraftAttachmentUpload = Omit<DraftAttachment, "url"> & { url?: string };

export interface DraftValue {
  text: string;
  attachments: DraftAttachment[];
}

/** React and the synchronizer can hold separate copies of the same draft. */
function sameDraft(current: DraftValue, expected: DraftValue): boolean {
  return current.text === expected.text && current.attachments.length === expected.attachments.length &&
    current.attachments.every((file, index) => {
      const other = expected.attachments[index]!;
      return file.id === other.id && file.name === other.name && file.mediaType === other.mediaType &&
        file.size === other.size && file.url === other.url;
    });
}

export interface DraftPayload {
  text: string;
  attachments: DraftAttachmentUpload[];
  /** Orders this client's writes even when requests reach the server out of order. */
  writeId?: { clientId: string; sequence: number };
}

/** The two draft routes, as `ApiClient` implements them. */
export interface DraftTransport {
  getDraft(key: string): Promise<DraftValue>;
  putDraft(key: string, draft: DraftPayload, options?: { keepalive?: boolean }): Promise<void>;
}

const writers = new WeakMap<DraftTransport, { clientId: string; sequence: number }>();
function nextWrite(transport: DraftTransport): NonNullable<DraftPayload["writeId"]> {
  let writer = writers.get(transport);
  if (writer == null) { writer = { clientId: crypto.randomUUID(), sequence: 0 }; writers.set(transport, writer); }
  return { clientId: writer.clientId, sequence: ++writer.sequence };
}

/**
 * One draft's lifetime, without React: the cache, the reconcile, the debounce
 * and the flush. `onRemote` paints server reconciliation and accepted-send
 * clearing into any view currently showing this draft.
 */
export class DraftSync {
  private text: string;
  private attachments: DraftAttachment[] = [];
  /** Set by the first edit; from then on the server's copy of the text is the stale one. */
  private typed = false;
  /** Set by the first change to the files; from then on the server's copy of them is the stale one. */
  private touchedFiles = false;
  /** Attachments the server has the bytes of; every other one goes up with its `url`. */
  private readonly uploaded = new Set<string>();
  /** There is a change the server has not been told about yet. */
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ceiling: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private revision = 0;
  private readonly writing = new Set<Promise<void>>();
  private acknowledged = 0;

  constructor(
    private readonly key: string,
    private readonly transport: DraftTransport,
    private readonly onRemote: (draft: DraftValue) => void,
  ) {
    this.text = readCache(key);
  }

  /** What to paint right now: the cached text, before the server has answered; no files yet. */
  get current(): DraftValue {
    return { text: this.text, attachments: this.attachments };
  }

  /**
   * Reconcile with the server. Its text wins unless the user has typed since
   * mount; its files win unless the user has added or removed one since.
   */
  async start(): Promise<void> {
    const remote = await this.transport.getDraft(this.key).catch(() => undefined);
    // A server that could not answer leaves the cached text exactly as it is.
    if (remote === undefined || this.disposed) return;
    let changed = false;
    if (!this.typed && remote.text !== this.text) {
      this.text = remote.text;
      writeCache(this.key, remote.text);
      changed = true;
    }
    if (!this.touchedFiles && remote.attachments.length > 0) {
      this.attachments = remote.attachments;
      changed = true;
    }
    // Whatever the server holds it already has the bytes of.
    for (const entry of remote.attachments) this.uploaded.add(entry.id);
    if (changed) {
      this.revision++;
      this.onRemote(this.current);
    }
  }

  /** A keystroke: cached at once, sent to the server on the debounce. */
  edit(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.revision++;
    this.typed = true;
    this.dirty = true;
    writeCache(this.key, text);
    this.schedule();
  }

  /**
   * A file added or a tile removed. Not debounced: this is not a keystroke,
   * and a file the user just dropped in should be on the server before the
   * window can be closed on it.
   */
  setAttachments(attachments: DraftAttachment[]): void {
    this.attachments = attachments;
    this.revision++;
    this.touchedFiles = true;
    this.dirty = true;
    this.flush();
  }

  /**
   * The message really went out, so the draft goes now rather than on the next
   * timer — a pending write would otherwise put the sent text back.
   */
  clear(expected?: DraftValue): boolean {
    if (expected && !sameDraft(this.current, expected)) return false;
    this.typed = true;
    this.touchedFiles = true;
    if (this.text !== "" || this.attachments.length > 0) {
      this.text = "";
      this.attachments = [];
      this.revision++;
      this.dirty = true;
      writeCache(this.key, "");
      this.onRemote(this.current);
    }
    this.flush();
    return true;
  }

  /** The accepted send consumes this revision, even if its input view has left. */
  async submit(send: () => Promise<boolean>): Promise<boolean> {
    const revision = this.revision;
    const accepted = await send();
    if (accepted && revision === this.revision) this.clear();
    return accepted;
  }

  /** Keep the shared draft alive until its last write has reached the server. */
  async settled(): Promise<void> {
    while (this.writing.size > 0) await Promise.all(this.writing);
  }

  get unsaved(): boolean { return this.dirty || this.writing.size > 0; }

  /** Write what is pending. `keepalive` is for a page that is going away. */
  flush(options?: { keepalive?: boolean }): void {
    this.cancel();
    if (!this.dirty) return;
    this.dirty = false;
    const sent = this.attachments;
    const writeId = nextWrite(this.transport);
    const payload: DraftPayload = {
      text: this.text,
      attachments: sent.map(({ url, ...meta }) => (this.writing.size === 0 && this.uploaded.has(meta.id) ? meta : { ...meta, url })),
      writeId,
    };
    // Start immediately, including pagehide's keepalive write. The server
    // rejects older sequence numbers; waiting for an earlier PUT here would
    // strand the newest text when the page closes before that PUT resolves.
    const writing = this.transport.putDraft(this.key, payload, options).then(
      () => {
        if (writeId.sequence < this.acknowledged) return;
        this.acknowledged = writeId.sequence;
        this.uploaded.clear();
        for (const entry of sent) this.uploaded.add(entry.id);
      },
      () => {
        if (writeId.sequence < this.acknowledged) return;
        // The cache still holds the text, and the next keystroke retries — with
        // the bytes again, since it is unknown how far this write got.
        this.dirty = true;
        this.uploaded.clear();
      },
    ).then(() => { this.writing.delete(writing); });
    this.writing.add(writing);
  }

  /** Task switch or unmount: one last write, then this instance is inert. */
  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private schedule(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS);
    // Started by the first edit of a burst and never restarted, so a typist who
    // never pauses still lands a write every `CEILING_MS`.
    this.ceiling ??= setTimeout(() => this.flush(), CEILING_MS);
  }

  private cancel(): void {
    if (this.timer != null) clearTimeout(this.timer);
    if (this.ceiling != null) clearTimeout(this.ceiling);
    this.timer = undefined;
    this.ceiling = undefined;
  }
}

interface DraftLease {
  sync: DraftSync;
  submit: (send: () => Promise<boolean>) => Promise<boolean>;
  release: () => void;
}

interface DraftSession {
  sync: DraftSync;
  listeners: Set<(value: DraftValue) => void>;
  references: number;
}

const sessions = new WeakMap<DraftTransport, Map<string, DraftSession>>();

/** A view and its outstanding sends share ownership of the same draft. */
export function acquireDraft(key: string, transport: DraftTransport, paint: (value: DraftValue) => void): DraftLease {
  let drafts = sessions.get(transport);
  if (drafts == null) { drafts = new Map(); sessions.set(transport, drafts); }
  let session = drafts.get(key);
  if (session == null) {
    const listeners = new Set<(value: DraftValue) => void>();
    const instance = new DraftSync(key, transport, value => { for (const listener of listeners) listener(value); });
    session = { sync: instance, listeners, references: 0 };
    drafts.set(key, session);
    void instance.start();
  }
  const held = session;
  held.references++;
  held.listeners.add(paint);
  paint(held.sync.current);
  // A prior failed save/clear is retried on reopening, before remote data can
  // replace the newer local value.
  if (held.sync.unsaved) held.sync.flush();
  const release = () => {
    held.references--;
    held.sync.flush();
    void held.sync.settled().then(() => {
      if (held.references !== 0 || held.sync.unsaved || drafts.get(key) !== held) return;
      held.sync.dispose();
      drafts.delete(key);
    });
  };
  let released = false;
  return {
    sync: held.sync,
    async submit(send) {
      held.references++;
      try { return await held.sync.submit(send); }
      finally { release(); }
    },
    release() {
      if (released) return;
      released = true;
      held.listeners.delete(paint);
      release();
    },
  };
}

export interface Draft {
  value: string;
  attachments: DraftAttachment[];
  /** Every keystroke. */
  edit: (text: string) => void;
  /** A file added or a tile removed. */
  setAttachments: (attachments: DraftAttachment[]) => void;
  /** Bind acceptance and consumption before the async action can unmount this view. */
  submit: (send: () => Promise<boolean>) => Promise<boolean>;
  /** Reconcile after an in-flight first send was refused and saved as this task's draft. */
  refresh: () => void;
}

/**
 * The draft of one task (or `NEW_TASK_DRAFT`), as React state. Mount paints the
 * cache, the server reconciles, and leaving flushes.
 */
export function useDraft(key: string, transport: DraftTransport): Draft {
  const [value, setValue] = useState(() => readCache(key));
  const [attachments, setAttachmentsState] = useState<DraftAttachment[]>([]);
  const lease = useRef<DraftLease | null>(null);

  useEffect(() => {
    const paint = (draft: DraftValue) => {
      setValue(draft.text);
      setAttachmentsState(draft.attachments);
    };
    const held = acquireDraft(key, transport, paint);
    const instance = held.sync;
    lease.current = held;
    // A tab being hidden or torn down is the one moment a debounced write would
    // be lost, so it goes out with `keepalive`.
    const onHide = () => {
      if (document.visibilityState === "hidden") instance.flush({ keepalive: true });
    };
    const onPageHide = () => instance.flush({ keepalive: true });
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onHide);
      held.release();
      if (lease.current === held) lease.current = null;
    };
  }, [key, transport]);

  const edit = useCallback((text: string) => {
    setValue(text);
    lease.current?.sync.edit(text);
  }, []);

  const setAttachments = useCallback((next: DraftAttachment[]) => {
    setAttachmentsState(next);
    lease.current?.sync.setAttachments(next);
  }, []);

  const submit = useCallback((send: () => Promise<boolean>) => lease.current?.submit(send) ?? Promise.resolve(false), []);
  const refresh = useCallback(() => { void lease.current?.sync.start(); }, []);

  return { value, attachments, edit, setAttachments, submit, refresh };
}
