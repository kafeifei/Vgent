import { useEffect, useSyncExternalStore } from "react";
import type { ApiClient } from "@/lib/api";
import { onAccountsChanged } from "@/lib/accountEvents";
import type { AccountSnapshot } from "@/lib/types";

type State = { snapshot?: AccountSnapshot; loading: boolean; error?: string };
function createStore(client: ApiClient) {
  let state: State = { loading: true }, generation = 0, usageReaders = 0;
  let pending: Promise<void> | undefined;
  let mounts = 0;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: State) => { state = next; for (const fn of listeners) fn(); };
  const refresh = (force = false): Promise<void> => {
    if (pending && !force) return pending;
    const current = ++generation;
    publish({ ...state, loading: true });
    const task = client.getAccounts(usageReaders > 0, force).then(snapshot => {
      if (current === generation) publish({ snapshot, loading: false });
    }, () => { if (current === generation) publish({ ...state, loading: false, error: "账号状态读取失败，请刷新重试" }); }).finally(() => { if (pending === task) pending = undefined; });
    pending = task; return task;
  };
  return {
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    get: () => state,
    refresh,
    mount(usage: boolean) {
      if (usage) usageReaders++;
      void refresh(usage);
      if (mounts++ === 0) {
        const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
        const focus = () => { void refresh(); };
        window.addEventListener("focus", focus);
        const remove = onAccountsChanged(client, () => { publish({ loading: true }); void refresh(true); });
        stop = () => { clearInterval(timer); window.removeEventListener("focus", focus); remove(); };
      }
      return () => { if (usage) usageReaders--; if (--mounts === 0) { stop?.(); stop = undefined; } };
    },
  };
}
const stores = new WeakMap<ApiClient, ReturnType<typeof createStore>>();
export function useAccounts(client: ApiClient, usage = false) {
  let store = stores.get(client);
  if (!store) { store = createStore(client); stores.set(client, store); }
  const shared = store;
  useEffect(() => shared.mount(usage), [shared, usage]);
  return { ...useSyncExternalStore(shared.subscribe, shared.get), refresh: () => shared.refresh(true) };
}
