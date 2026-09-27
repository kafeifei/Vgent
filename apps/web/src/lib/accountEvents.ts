const listeners = new WeakMap<object, Set<() => void>>();
export function onAccountsChanged(client: object, fn: () => void) {
  let group = listeners.get(client);
  if (!group) { group = new Set(); listeners.set(client, group); }
  group.add(fn);
  return () => { group!.delete(fn); };
}
export function accountsChanged(client: object) { for (const fn of listeners.get(client) ?? []) fn(); }
