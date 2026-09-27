import type { ApiClient } from "@/lib/api";
import { accountsChanged, onAccountsChanged } from "@/lib/accountEvents";
import type { AccountSnapshot, AccountSummary } from "@/lib/types";

type State = { snapshot?: AccountSnapshot; refreshing: boolean; error?: string | undefined };
const accountIdentity = (a: AccountSummary) => JSON.stringify([a.id, a.loggedIn, a.username, a.email, a.method]);
const identityOf = (snapshot: AccountSnapshot) => snapshot.accounts.map(accountIdentity).join(";");
const REFRESH_INTERVAL = 60_000;

/** The app owns polling; opening the panel only reads the last complete snapshot. */
export function createAccountStore(client: Pick<ApiClient, "getAccounts">) {
  let state: State = { refreshing: true }, generation = 0, mounts = 0;
  let pending: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; for (const fn of listeners) fn(); };
  const refresh = (force = false): Promise<void> => {
    if (pending) return pending;
    const current = generation;
    publish({ ...state, refreshing: true, error: undefined });
    const promise = client.getAccounts(true, force).then(snapshot => {
      if (current !== generation) return;
      const changed = state.snapshot != null && identityOf(state.snapshot) !== identityOf(snapshot);
      let error: string | undefined;
      const accounts = snapshot.accounts.map(account => {
        const previous = state.snapshot?.accounts.find(a => a.id === account.id);
        if (account.usage?.status === "unavailable" && previous?.usage?.status === "ready" && accountIdentity(previous) === accountIdentity(account)) {
          error = "部分额度刷新失败，仍显示上次结果";
          return { ...account, usage: previous.usage };
        }
        return account;
      });
      publish({ snapshot: { ...snapshot, accounts }, refreshing: false, error });
      // Other surfaces reload their models; this store already has the new identity.
      if (changed) accountsChanged(client, "snapshot");
    }, () => {
      if (current === generation) publish({ ...state, refreshing: false, error: "账号状态读取失败，请刷新重试" });
    }).finally(() => { if (pending === promise) pending = undefined; });
    pending = promise;
    return promise;
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => state,
    refresh,
    mount() {
      if (mounts++ === 0) {
        void refresh();
        const timer = setInterval(() => { void refresh(true); }, REFRESH_INTERVAL);
        const remove = onAccountsChanged(client, reason => {
          if (reason === "snapshot") return;
          generation++;
          pending = undefined;
          void refresh(true);
        });
        stop = () => { clearInterval(timer); remove(); };
      }
      return () => { if (--mounts === 0) { stop?.(); stop = undefined; } };
    },
  };
}
