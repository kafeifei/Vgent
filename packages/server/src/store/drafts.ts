import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeDataUrl } from "../attachments.js";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

/**
 * 草稿任何情况下不丢: the half-typed message of every task — its text *and*
 * the files waiting in the composer — in `<dataDir>/drafts.json` plus
 * `<dataDir>/drafts/<key>/<attachmentId>`.
 *
 * It lives on the server rather than in the browser because the desktop shell
 * starts the backend on a random port (`--port 0`), and the port is part of the
 * WebView's origin — so `localStorage` is empty on every launch. The web side
 * keeps a copy of the text, but only as an instant cache; the files are too big
 * for that cache and come from here alone.
 *
 * It is deliberately not part of the thread record either: a draft changes on
 * every other keystroke, and a thread record carries the whole message array.
 * One small file for all of them is rewritten in full, which is why the client
 * debounces. The attachment bytes are *not* in that file: each is written once,
 * under its own id, and the JSON only names it.
 */

/** The empty state's own draft; it has no task yet. */
export const NEW_TASK_DRAFT = "new";

/** Bigger than any message a human types into the composer; past this the request is refused. */
export const MAX_DRAFT_BYTES = 64 * 1024;

/** Per file, the same ceiling the composer applies when a file is picked. */
export const MAX_DRAFT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Files per draft. Nobody attaches more by hand; a runaway client must not fill the disk. */
export const MAX_DRAFT_ATTACHMENTS = 20;

/** A thread id (a uuid) or `new`. Nothing else may name a file's key — or an attachment's id. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isDraftKey = (value: unknown): value is string => typeof value === "string" && KEY_PATTERN.test(value);

/** `image/png`, `application/pdf`: one type, one subtype, no parameters. It ends up inside a `data:` URL. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export const isDraftMediaType = (value: unknown): value is string => typeof value === "string" && MEDIA_TYPE_PATTERN.test(value);

/** What the JSON keeps about one attachment; the bytes are in the file named by `id`. */
export interface DraftAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

/**
 * One attachment as the client sends it. `url` (a `data:` URL) is present the
 * first time the client mentions the file; afterwards the id alone is enough,
 * so a keystroke's write does not carry the bytes again.
 */
export interface DraftAttachmentInput extends DraftAttachment {
  url?: string;
}

/** What the client reads back: the attachment with its bytes, ready to draw and to send. */
export interface DraftAttachmentOutput extends DraftAttachment {
  url: string;
}

export interface Draft {
  text: string;
  attachments: DraftAttachmentOutput[];
}

export interface DraftWriteId { clientId: string; sequence: number }

interface StoredDraft {
  text: string;
  attachments: DraftAttachment[];
}

interface DraftsFile {
  version: 2;
  /** Key → draft. An absent key and a blank draft (no text, no files) are the same thing, so blanks are never stored. */
  drafts: Record<string, StoredDraft>;
}

/** The file before attachments existed: key → text. Read once and rewritten in the new shape on the next write. */
interface DraftsFileV1 {
  version: 1;
  drafts: Record<string, string>;
}

/** The client named an attachment by id alone, and this store has never seen it. */
export class UnknownDraftAttachmentError extends Error {
  constructor(readonly id: string) {
    super(`草稿附件 ${id} 不存在，要带上内容`);
    this.name = "UnknownDraftAttachmentError";
  }
}

export interface DraftStore {
  /** The stored draft, or a blank one when there is none. Attachments whose file went missing are left out. */
  get(key: string): Promise<Draft>;
  /**
   * Replaces it. Attachments not in the list are deleted; a new one must carry
   * its `url`. No text and no attachments deletes the entry.
   */
  put(key: string, text: string, attachments?: readonly DraftAttachmentInput[], writeId?: DraftWriteId): Promise<DraftAttachment[]>;
  /** Deleted with the task. */
  remove(key: string): Promise<void>;
}

const isStoredDraft = (value: unknown): value is StoredDraft =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredDraft).text === "string" &&
  Array.isArray((value as StoredDraft).attachments);

const isAttachmentMeta = (value: unknown): value is DraftAttachment =>
  typeof value === "object" &&
  value !== null &&
  isDraftKey((value as DraftAttachment).id) &&
  typeof (value as DraftAttachment).name === "string" &&
  isDraftMediaType((value as DraftAttachment).mediaType) &&
  typeof (value as DraftAttachment).size === "number";

const isDraftsFile = (value: unknown): value is DraftsFile | DraftsFileV1 =>
  typeof value === "object" && value !== null && typeof (value as DraftsFile).drafts === "object";

/** Either shape on disk, as the in-memory map. Blanks and anything malformed are dropped. */
function loadDrafts(stored: DraftsFile | DraftsFileV1 | undefined): Record<string, StoredDraft> {
  const drafts: Record<string, StoredDraft> = {};
  for (const [key, entry] of Object.entries(stored?.drafts ?? {})) {
    if (!isDraftKey(key)) continue;
    if (typeof entry === "string") {
      if (entry !== "") drafts[key] = { text: entry, attachments: [] };
      continue;
    }
    if (!isStoredDraft(entry)) continue;
    const attachments = entry.attachments.filter(isAttachmentMeta);
    if (entry.text !== "" || attachments.length > 0) drafts[key] = { text: entry.text, attachments };
  }
  return drafts;
}

export function createDraftStore(dataDir: string, log: Logger = silentLogger): DraftStore {
  const path = join(dataDir, "drafts.json");
  const filesDir = join(dataDir, "drafts");
  const dirOf = (key: string): string => join(filesDir, key);
  const fileOf = (key: string, id: string): string => join(filesDir, key, id);
  let drafts: Record<string, StoredDraft> | undefined;
  let ready: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  // Requests cannot survive a server restart. Keep heads for deleted drafts
  // too, so a late save cannot recreate a draft that was just consumed.
  const writeHeads = new Map<string, number>();

  const ensureReady = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const stored = await readJsonOrQuarantine<DraftsFile | DraftsFileV1>(path, { validate: isDraftsFile, log });
      drafts = loadDrafts(stored);
    })();
    return ready;
  };

  /**
   * Every write — the JSON and the files around it — is serialized, so two
   * keystrokes' worth of PUTs cannot interleave, and a removal cannot race the
   * upload it is meant to undo.
   */
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  const save = (): Promise<void> => {
    const file: DraftsFile = { version: 2, drafts: { ...(drafts ?? {}) } };
    return writeJsonAtomic(path, file, { mode: 0o600 });
  };

  const sameMeta = (a: readonly DraftAttachment[], b: readonly DraftAttachment[]): boolean =>
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other != null && other.id === entry.id && other.name === entry.name && other.mediaType === entry.mediaType && other.size === entry.size;
    });

  return {
    async get(key) {
      await ensureReady();
      const stored = drafts?.[key];
      if (stored == null) return { text: "", attachments: [] };
      const attachments: DraftAttachmentOutput[] = [];
      for (const meta of stored.attachments) {
        const bytes = await readFile(fileOf(key, meta.id)).catch((error: unknown) => {
          log.warn(`草稿 ${key} 的附件 ${meta.name} 读不到`, error);
          return undefined;
        });
        if (bytes == null) continue;
        attachments.push({ ...meta, url: `data:${meta.mediaType};base64,${bytes.toString("base64")}` });
      }
      return { text: stored.text, attachments };
    },

    put(key, text, attachments = [], writeId) {
      return serialized(async () => {
        await ensureReady();
        drafts ??= {};
        const before = drafts[key];
        const writerKey = writeId == null ? undefined : `${key}:${writeId.clientId}`;
        if (writeId != null && writeId.sequence <= (writeHeads.get(writerKey!) ?? 0)) return before?.attachments ?? [];
        const known = new Set((before?.attachments ?? []).map((entry) => entry.id));
        // Everything the client did not send bytes for must already be on disk.
        for (const entry of attachments) {
          if (entry.url == null && !known.has(entry.id)) throw new UnknownDraftAttachmentError(entry.id);
        }
        if (writeId != null) writeHeads.set(writerKey!, writeId.sequence);
        const next: DraftAttachment[] = [];
        for (const entry of attachments) {
          const meta: DraftAttachment = { id: entry.id, name: entry.name, mediaType: entry.mediaType, size: entry.size };
          if (entry.url != null) {
            const bytes = decodeDataUrl(entry.url);
            if (bytes == null) throw new UnknownDraftAttachmentError(entry.id);
            await mkdir(dirOf(key), { recursive: true, mode: 0o700 });
            await writeFile(fileOf(key, entry.id), bytes, { mode: 0o600 });
            meta.size = bytes.byteLength;
          }
          next.push(meta);
        }
        // Files the list no longer names go, whether the user removed one tile or sent the message.
        const keep = new Set(next.map((entry) => entry.id));
        for (const id of known) {
          if (!keep.has(id)) await rm(fileOf(key, id), { force: true }).catch(() => undefined);
        }
        if (text === "" && next.length === 0) {
          if (before === undefined) return next;
          delete drafts[key];
          await rm(dirOf(key), { recursive: true, force: true }).catch(() => undefined);
          await save();
          return next;
        }
        if (before != null && before.text === text && sameMeta(before.attachments, next)) return next;
        drafts[key] = { text, attachments: next };
        await save();
        return next;
      });
    },

    remove(key) {
      return serialized(async () => {
        await ensureReady();
        await rm(dirOf(key), { recursive: true, force: true }).catch(() => undefined);
        if (drafts?.[key] === undefined) return;
        delete drafts[key];
        await save();
      });
    },
  };
}
