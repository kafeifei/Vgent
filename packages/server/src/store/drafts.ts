import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

/**
 * 草稿任何情况下不丢: the half-typed message of every task, in
 * `<dataDir>/drafts.json`.
 *
 * It lives on the server rather than in the browser because the desktop shell
 * starts the backend on a random port (`--port 0`), and the port is part of the
 * WebView's origin — so `localStorage` is empty on every launch. The web side
 * keeps a copy of it, but only as an instant cache.
 *
 * It is deliberately not part of the thread record either: a draft changes on
 * every other keystroke, and a thread record carries the whole message array.
 * One small file for all of them is rewritten in full, which is why the client
 * debounces.
 */

/** The empty state's own draft; it has no task yet. */
export const NEW_TASK_DRAFT = "new";

/** Bigger than any message a human types into the composer; past this the request is refused. */
export const MAX_DRAFT_BYTES = 64 * 1024;

/** A thread id (a uuid) or `new`. Nothing else may name a file's key. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isDraftKey = (value: unknown): value is string => typeof value === "string" && KEY_PATTERN.test(value);

interface DraftsFile {
  version: 1;
  /** Key → text. An absent key and an empty text are the same thing, so blanks are never stored. */
  drafts: Record<string, string>;
}

export interface DraftStore {
  /** The stored text, or `""` when there is none. */
  get(key: string): Promise<string>;
  /** Replaces it; `""` deletes the entry. */
  put(key: string, text: string): Promise<void>;
  /** Deleted with the task. */
  remove(key: string): Promise<void>;
}

const isDraftsFile = (value: unknown): value is DraftsFile =>
  typeof value === "object" && value !== null && typeof (value as DraftsFile).drafts === "object";

export function createDraftStore(dataDir: string, log: Logger = silentLogger): DraftStore {
  const path = join(dataDir, "drafts.json");
  let drafts: Record<string, string> | undefined;
  let ready: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const ensureReady = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const stored = await readJsonOrQuarantine<DraftsFile>(path, { validate: isDraftsFile, log });
      drafts = {};
      for (const [key, text] of Object.entries(stored?.drafts ?? {})) {
        if (isDraftKey(key) && typeof text === "string" && text !== "") drafts[key] = text;
      }
    })();
    return ready;
  };

  /** Writes are serialized, so two keystrokes' worth of PUTs cannot interleave. */
  const save = async (): Promise<void> => {
    const file: DraftsFile = { version: 1, drafts: { ...(drafts ?? {}) } };
    const work = () => writeJsonAtomic(path, file, { mode: 0o600 });
    chain = chain.then(work, work);
    await chain;
  };

  return {
    async get(key) {
      await ensureReady();
      return drafts?.[key] ?? "";
    },

    async put(key, text) {
      await ensureReady();
      drafts ??= {};
      if (drafts[key] === text || (text === "" && drafts[key] === undefined)) return;
      if (text === "") delete drafts[key];
      else drafts[key] = text;
      await save();
    },

    async remove(key) {
      await ensureReady();
      if (drafts?.[key] === undefined) return;
      delete drafts[key];
      await save();
    },
  };
}
