const listeners = new WeakMap<object, Set<(reason?: "snapshot") => void>>();
export function onAccountsChanged(client: object, fn: (reason?: "snapshot") => void) {
  let group = listeners.get(client);
  if (!group) { group = new Set(); listeners.set(client, group); }
  group.add(fn);
  return () => { group!.delete(fn); };
}
export function accountsChanged(client: object, reason?: "snapshot") { for (const fn of listeners.get(client) ?? []) fn(reason); }
