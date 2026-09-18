import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 草稿任何情况下不丢: what is half-typed in the composer, per task.
 *
 * The server owns it (`GET` / `PUT /api/drafts/:key`); `localStorage` is only
 * an instant cache. It has to be the server: the desktop shell starts the
 * backend on a random port, the port is part of the WebView's origin, and
 * per-origin storage is therefore empty on every launch — drafts written in the
 * last session would be unreachable.
 *
 * Opening a task paints the cached text at once and then reconciles: the server
 * wins, unless the user has already typed since this view mounted. Writes are
 * debounced 300 ms with a 2 s ceiling and flushed on task switch, unmount and
 * `pagehide` / `visibilitychange`.
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

/** The two draft routes, as `ApiClient` implements them. */
export interface DraftTransport {
  getDraft(key: string): Promise<string>;
  putDraft(key: string, text: string, options?: { keepalive?: boolean }): Promise<void>;
}

/**
 * One draft's lifetime, without React: the cache, the reconcile, the debounce
 * and the flush. `onRemote` is called only when the server's copy replaces what
 * is on screen.
 */
export class DraftSync {
  private text: string;
  /** Set by the first edit; from then on the server's copy is the stale one. */
  private typed = false;
  /** There is a change the server has not been told about yet. */
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ceiling: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly key: string,
    private readonly transport: DraftTransport,
    private readonly onRemote: (text: string) => void,
  ) {
    this.text = readCache(key);
  }

  /** What to paint right now: the cache, before the server has answered. */
  get current(): string {
    return this.text;
  }

  /** Reconcile with the server. Its copy wins unless the user has typed since mount. */
  async start(): Promise<void> {
    const remote = await this.transport.getDraft(this.key).catch(() => undefined);
    // A server that could not answer leaves the cached text exactly as it is.
    if (remote === undefined || this.disposed || this.typed || remote === this.text) return;
    this.text = remote;
    writeCache(this.key, remote);
    this.onRemote(remote);
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
   * The message really went out, so the draft goes now rather than on the next
   * timer — a pending write would otherwise put the sent text back.
   */
  clear(): void {
    this.typed = true;
    if (this.text !== "") {
      this.text = "";
      this.dirty = true;
      writeCache(this.key, "");
    }
    this.flush();
  }

  /** Write what is pending. `keepalive` is for a page that is going away. */
  flush(options?: { keepalive?: boolean }): void {
    this.cancel();
    if (!this.dirty) return;
    this.dirty = false;
    void this.transport.putDraft(this.key, this.text, options).catch(() => {
      // The cache still holds it, and the next keystroke retries.
      this.dirty = true;
    });
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
  /** Every keystroke. */
  edit: (text: string) => void;
  /** The text went out: drop it here and on the server, right now. */
  clear: () => void;
}

/**
 * The draft of one task (or `NEW_TASK_DRAFT`), as React state. Mount paints the
 * cache, the server reconciles, and leaving flushes.
 */
export function useDraft(key: string, transport: DraftTransport): Draft {
  const [value, setValue] = useState(() => readCache(key));
  const sync = useRef<DraftSync | null>(null);

  useEffect(() => {
    const instance = new DraftSync(key, transport, setValue);
    sync.current = instance;
    setValue(instance.current);
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

  const clear = useCallback(() => {
    setValue("");
    sync.current?.clear();
  }, []);

  return { value, edit, clear };
}
