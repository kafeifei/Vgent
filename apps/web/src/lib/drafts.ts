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

export interface DraftPayload {
  text: string;
  attachments: DraftAttachmentUpload[];
}

/** The two draft routes, as `ApiClient` implements them. */
export interface DraftTransport {
  getDraft(key: string): Promise<DraftValue>;
  putDraft(key: string, draft: DraftPayload, options?: { keepalive?: boolean }): Promise<void>;
}

/**
 * One draft's lifetime, without React: the cache, the reconcile, the debounce
 * and the flush. `onRemote` is called only when the server's copy replaces what
 * is on screen.
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
    if (changed) this.onRemote(this.current);
  }

  /** A keystroke: cached at once, sent to the server on the debounce. */
  edit(text: string): void {
    if (text === this.text) return;
    this.text = text;
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
    this.touchedFiles = true;
    this.dirty = true;
    this.flush();
  }

  /**
   * The message really went out, so the draft goes now rather than on the next
   * timer — a pending write would otherwise put the sent text back.
   */
  clear(expected?: DraftValue): boolean {
    if (expected && (this.text !== expected.text || this.attachments !== expected.attachments)) return false;
    this.typed = true;
    this.touchedFiles = true;
    if (this.text !== "" || this.attachments.length > 0) {
      this.text = "";
      this.attachments = [];
      this.dirty = true;
      writeCache(this.key, "");
    }
    this.flush();
    return true;
  }

  /** Write what is pending. `keepalive` is for a page that is going away. */
  flush(options?: { keepalive?: boolean }): void {
    this.cancel();
    if (!this.dirty) return;
    this.dirty = false;
    const sent = this.attachments;
    const payload: DraftPayload = {
      text: this.text,
      attachments: sent.map(({ url, ...meta }) => (this.uploaded.has(meta.id) ? meta : { ...meta, url })),
    };
    void this.transport.putDraft(this.key, payload, options).then(
      () => {
        for (const entry of sent) this.uploaded.add(entry.id);
      },
      () => {
        // The cache still holds the text, and the next keystroke retries — with
        // the bytes again, since it is unknown how far this write got.
        this.dirty = true;
        this.uploaded.clear();
      },
    );
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

export interface Draft {
  value: string;
  attachments: DraftAttachment[];
  /** Every keystroke. */
  edit: (text: string) => void;
  /** A file added or a tile removed. */
  setAttachments: (attachments: DraftAttachment[]) => void;
  /** The message went out: drop text and files here and on the server, right now. */
  clear: (expected?: DraftValue) => void;
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
  const sync = useRef<DraftSync | null>(null);

  useEffect(() => {
    const paint = (draft: DraftValue) => {
      setValue(draft.text);
      setAttachmentsState(draft.attachments);
    };
    const instance = new DraftSync(key, transport, paint);
    sync.current = instance;
    paint(instance.current);
    void instance.start();
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
      instance.dispose();
      if (sync.current === instance) sync.current = null;
    };
  }, [key, transport]);

  const edit = useCallback((text: string) => {
    setValue(text);
    sync.current?.edit(text);
  }, []);

  const setAttachments = useCallback((next: DraftAttachment[]) => {
    setAttachmentsState(next);
    sync.current?.setAttachments(next);
  }, []);

  const clear = useCallback((expected?: DraftValue) => {
    if (sync.current && !sync.current.clear(expected)) return;
    setValue("");
    setAttachmentsState([]);
  }, []);

  const refresh = useCallback(() => { void sync.current?.start(); }, []);

  return { value, attachments, edit, setAttachments, clear, refresh };
}
