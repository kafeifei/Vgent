import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";
const digest = (messages: readonly ModelMessage[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
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
    if (digest(original.slice(0, cache.count)) !== cache.digest) return original;
    return [...cache.messages, ...original.slice(cache.count)];
  } catch {
    return original;
  }
}

export async function saveContext(dir: string, original: ModelMessage[], messages: ModelMessage[]): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "context-state.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, count: original.length, digest: digest(original), messages } satisfies ContextCache),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
