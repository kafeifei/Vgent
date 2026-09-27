import type { ApiClient } from "@/lib/api";
import { accountsChanged } from "@/lib/accountEvents";
import type { AccountSnapshot } from "@/lib/types";

type State = { snapshot?: AccountSnapshot; usageSnapshot?: AccountSnapshot | undefined; loading: boolean; error?: string | undefined };
const identityOf = (snapshot: AccountSnapshot) => JSON.stringify(snapshot.accounts.map(a => [a.id, a.loggedIn, a.username, a.email, a.method]));

/** Identity reads never replace a complete quota view. Publish each view atomically. */
export function createAccountStore(client: Pick<ApiClient, "getAccounts">) {
  let state: State = { loading: true }, generation = 0, identityAt = 0, usageAt = 0;
  let pending: { usage: boolean; promise: Promise<void> } | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; for (const fn of listeners) fn(); };
  const refresh = (usage = false, force = false): Promise<void> => {
    if (pending) {
      if (!usage || pending.usage) return pending.promise;
      return pending.promise.then(() => refresh(true, force));
    }
    if (!force && Date.now() - (usage ? usageAt : identityAt) < 60_000) return Promise.resolve();
    const current = generation;
    publish({ ...state, loading: true, error: undefined });
    const promise = client.getAccounts(usage, force).then(snapshot => {
      if (current !== generation) return;
      const changed = state.snapshot != null && identityOf(state.snapshot) !== identityOf(snapshot);
      identityAt = Date.now();
      if (usage) usageAt = identityAt;
      else if (changed) usageAt = 0;
      publish({ snapshot, usageSnapshot: usage ? snapshot : changed ? undefined : state.usageSnapshot, loading: false });
      // Other surfaces reload their models; this store already has the new identity.
      if (changed) accountsChanged(client, "snapshot");
    }, () => {
      if (current === generation) publish({ ...state, loading: false, error: "账号状态读取失败，请刷新重试" });
    }).finally(() => { if (pending?.promise === promise) pending = undefined; });
    pending = { usage, promise };
    return promise;
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => state,
    refresh,
    invalidate() { generation++; identityAt = 0; usageAt = 0; pending = undefined; },
  };
}
