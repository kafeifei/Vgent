import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * 计划文档: one markdown file per task, in `<dataDir>/plans/<threadId>.md`.
 *
 * It is deliberately not part of the thread record. The user edits it by hand
 * between turns, a finished Plan turn overwrites it wholesale, and Build reads
 * it back verbatim — none of which wants to ride on the message array or on the
 * record's `updatedAt`.
 */

/** Bigger than any plan a human will edit; past this the request is refused rather than truncated. */
export const MAX_PLAN_BYTES = 256 * 1024;

export interface PlanDocument {
  content: string;
  /** The file's mtime. Absent when there is no plan yet. */
  updatedAt?: string;
}

export interface PlanStore {
  /** The task's plan, or an empty document when it has none. */
  get(threadId: string): Promise<PlanDocument>;
  /** Replaces it. The caller has already checked the size and that the task is idle. */
  put(threadId: string, content: string): Promise<PlanDocument>;
  /** Deleted with the task. */
  remove(threadId: string): Promise<void>;
}

export function createPlanStore(dataDir: string, log: Logger = silentLogger): PlanStore {
  const dir = join(dataDir, "plans");
  const path = (threadId: string) => join(dir, `${threadId}.md`);
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {});
    return ready;
  };

  return {
    async get(threadId) {
      await ensureReady();
      const handle = await open(path(threadId), "r").catch(() => undefined);
      if (handle == null) return { content: "" };
      try {
        const [content, info] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
        return { content, updatedAt: info.mtime.toISOString() };
      } catch (error) {
        log.warn(`读取计划文档失败 (thread ${threadId})`, error);
        return { content: "" };
      } finally {
        await handle.close();
      }
    },

    async put(threadId, content) {
      await ensureReady();
      await writeFileAtomic(path(threadId), content, { mode: 0o600 });
      const info = await stat(path(threadId));
      return { content, updatedAt: info.mtime.toISOString() };
    },

    async remove(threadId) {
      await rm(path(threadId), { force: true });
    },
  };
}
