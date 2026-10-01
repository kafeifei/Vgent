import type { ApiClient } from "@/lib/api";
import { accountsChanged, onAccountsChanged } from "@/lib/accountEvents";
import type { AccountSnapshot, AccountSummary } from "@/lib/types";

type State = { snapshot?: AccountSnapshot; refreshing: boolean; error?: string | undefined };
const accountIdentity = (a: AccountSummary) => JSON.stringify([a.id, a.loggedIn, a.username, a.email, a.method]);
const identityOf = (snapshot: AccountSnapshot) => snapshot.accounts.map(accountIdentity).join(";");
const REFRESH_INTERVAL = 60_000;

/** Poll the local snapshot. Only a visible quota surface may ask the server for a guarded fallback. */
export function createAccountStore(client: Pick<ApiClient, "getAccounts">) {
  let state: State = { refreshing: true }, generation = 0, mounts = 0;
  let usageViewers = 0, pendingUsage = false;
  const canFallback = () => usageViewers > 0 && (typeof document === "undefined" || document.visibilityState !== "hidden");
  let pending: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; for (const fn of listeners) fn(); };
  const refresh = (force = false, usage = false): Promise<void> => {
    if (pending) return usage && !pendingUsage ? pending.then(() => (force || canFallback() ? refresh(force, usage) : undefined)) : pending;
    const current = generation;
    publish({ ...state, refreshing: true, error: undefined });
    const promise = client.getAccounts(usage, force).then(snapshot => {
      if (current !== generation) return;
      const changed = state.snapshot != null && identityOf(state.snapshot) !== identityOf(snapshot);
      let error: string | undefined;
      const accounts = snapshot.accounts.map(account => {
        const previous = state.snapshot?.accounts.find(a => a.id === account.id);
        if (account.usage?.status === "unavailable" && previous?.usage?.status === "ready" && accountIdentity(previous) === accountIdentity(account)) {
          error = "部分额度刷新失败，仍显示上次结果";
          return { ...account, usage: { ...previous.usage, message: account.usage.message ?? "额度补查失败；显示上次结果", ...(account.usage.retryAt ? { retryAt: account.usage.retryAt } : {}) } };
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
    pendingUsage = usage;
    return promise;
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => state,
    refresh,
    watchUsage() {
      usageViewers++;
      void refresh(false, canFallback());
      return () => { usageViewers--; };
    },
    mount() {
      if (mounts++ === 0) {
        void refresh();
        const timer = setInterval(() => { void refresh(false, canFallback()); }, REFRESH_INTERVAL);
        const remove = onAccountsChanged(client, reason => {
          if (reason === "snapshot") return;
          generation++;
          pending = undefined;
          void refresh(true, canFallback());
        });
        stop = () => { clearInterval(timer); remove(); };
      }
      return () => { if (--mounts === 0) { stop?.(); stop = undefined; } };
    },
  };
}
