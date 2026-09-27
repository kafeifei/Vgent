import { useEffect, useSyncExternalStore } from "react";
import type { ApiClient } from "@/lib/api";
import { onAccountsChanged } from "@/lib/accountEvents";
import { createAccountStore } from "./accountStore";

function createStore(client: ApiClient) {
  const store = createAccountStore(client);
  let mounts = 0, usageReaders = 0;
  let stop: (() => void) | undefined;
  return {
    ...store,
    mount(usage: boolean) {
      if (usage) usageReaders++;
      void store.refresh(usage);
      if (mounts++ === 0) {
        const refresh = () => { if (document.visibilityState === "visible") void store.refresh(usageReaders > 0); };
        const timer = window.setInterval(refresh, 60_000);
        window.addEventListener("focus", refresh);
        const remove = onAccountsChanged(client, reason => {
          if (reason === "snapshot") return;
          store.invalidate();
          void store.refresh(usageReaders > 0, true);
        });
        stop = () => { clearInterval(timer); window.removeEventListener("focus", refresh); remove(); };
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
  const state = useSyncExternalStore(shared.subscribe, shared.get);
  return { ...state, snapshot: usage ? state.usageSnapshot : state.snapshot, refresh: () => shared.refresh(usage, true) };
}
