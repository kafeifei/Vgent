import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
const digest = (messages: readonly ModelMessage[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

/** JSON may omit optional object properties, but must not degrade SDK attachment values. */
function isJsonSafe(value: unknown, ancestors = new Set<object>()): boolean {
  try {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || ancestors.has(value)) return false;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    ancestors.add(value);
    try {
      return array
        ? Array.from(value).every((entry) => isJsonSafe(entry, ancestors))
        : Object.values(value).every((entry) => entry === undefined || isJsonSafe(entry, ancestors));
    } finally {
      ancestors.delete(value);
    }
  } catch {
    return false;
  }
}
interface ContextCache {
  version: 1;
  count: number;
  digest: string;
  messages: ModelMessage[];
}

/** Reuse only an exact original prefix. Edited history, forks and tool continuations fall back safely. */
export async function restoreContext(dir: string, original: ModelMessage[]): Promise<ModelMessage[]> {
  try {
    const path = join(dir, "context-state.json");
    if ((await stat(path)).size > 8 * 1024 * 1024) return original;
    const cache = JSON.parse(await readFile(path, "utf8")) as ContextCache;
    if (
      cache.version !== 1 ||
      !Number.isInteger(cache.count) ||
      cache.count < 1 ||
      cache.count > original.length ||
      !Array.isArray(cache.messages)
    )
      return original;
    const prefix = original.slice(0, cache.count);
    if (!isJsonSafe(prefix) || digest(prefix) !== cache.digest) return original;
    return [...cache.messages, ...original.slice(cache.count)];
  } catch {
    return original;
  }
}

export async function saveContext(dir: string, original: ModelMessage[], messages: ModelMessage[]): Promise<void> {
  let temporary: string | undefined;
  try {
    if (!isJsonSafe(original) || !isJsonSafe(messages)) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "context-state.json");
    temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, count: original.length, digest: digest(original), messages } satisfies ContextCache),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } catch {
    // Context caching is disposable; filesystem failures must not interrupt execution.
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}
