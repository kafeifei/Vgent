/** Process-local coordination for all host tools, including parent/child agents.
 * External processes are not locked; callers still check for observed changes.
 */
import { createHash } from "node:crypto";
const host = new Map<string, Promise<void>>();
const sandboxes = new WeakMap<object, Map<string, Promise<void>>>();
export type ObservedFiles = Map<string, string>;
export const fingerprint = (content: string): string => createHash("sha256").update(content).digest("hex");
export async function mutateFile<T>(path: string, signal: AbortSignal | undefined, work: () => Promise<T>, scope?: object): Promise<T> {
  signal?.throwIfAborted();
  let queue = host;
  if (scope) {
    queue = sandboxes.get(scope) ?? new Map();
    sandboxes.set(scope, queue);
  }
  const previous = queue.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.set(path, next);
  await previous;
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    release();
    if (queue.get(path) === next) queue.delete(path);
  }
}
