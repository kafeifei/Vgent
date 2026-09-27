import { useEffect, useSyncExternalStore } from "react";
import type { ApiClient } from "@/lib/api";
import { createAccountStore } from "./accountStore";

const stores = new WeakMap<ApiClient, ReturnType<typeof createAccountStore>>();
export function useAccounts(client: ApiClient) {
  let store = stores.get(client);
  if (!store) { store = createAccountStore(client); stores.set(client, store); }
  const shared = store;
  useEffect(() => shared.mount(), [shared]);
  return { ...useSyncExternalStore(shared.subscribe, shared.get), refresh: () => shared.refresh(true) };
}
