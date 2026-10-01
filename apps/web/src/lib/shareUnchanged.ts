const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const hasId = (value: unknown): value is { id: string } => isPlain(value) && typeof value.id === "string";

/**
 * Structural sharing for JSON that arrives whole on every push: whatever in
 * `next` equals what `previous` already held keeps the *old* object, so a
 * snapshot that changed one task hands every other task (and every list that
 * did not change) back with the identity it had before. `memo` boundaries and
 * `useEffect` dependencies downstream then see exactly what changed and
 * nothing else. Lists of `{ id }` records are matched by id, other lists by
 * position; values that are not plain JSON come back as `next`.
 */
export function shareUnchanged<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) return shareList(previous, next) as unknown as T;
  if (isPlain(previous) && isPlain(next)) return shareRecord(previous, next) as unknown as T;
  return next;
}

function shareList(previous: readonly unknown[], next: readonly unknown[]): unknown[] {
  const byId = next.every(hasId) && previous.every(hasId)
    ? new Map(previous.map((item): [string, unknown] => [(item as { id: string }).id, item]))
    : undefined;
  const merged = next.map((item, index) => shareUnchanged(byId == null ? previous[index] : byId.get((item as { id: string }).id), item));
  const same = merged.length === previous.length && merged.every((item, index) => item === previous[index]);
  return same ? (previous as unknown[]) : merged;
}

function shareRecord(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next);
  const merged: Record<string, unknown> = {};
  let same = keys.length === Object.keys(previous).length;
  for (const key of keys) {
    const value = shareUnchanged(previous[key], next[key]);
    merged[key] = value;
    if (!Object.hasOwn(previous, key) || value !== previous[key]) same = false;
  }
  return same ? previous : merged;
}
