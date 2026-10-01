import { useEffect, useSyncExternalStore } from "react";
import type { ApiClient } from "@/lib/api";
import { createAccountStore } from "./accountStore";

const stores = new WeakMap<ApiClient, ReturnType<typeof createAccountStore>>();
export function useAccounts(client: ApiClient, showUsage = false): ReturnType<ReturnType<typeof createAccountStore>["get"]> & { refresh(): Promise<void>; watchUsage?: () => () => void } {
  let store = stores.get(client);
  if (!store) { store = createAccountStore(client); stores.set(client, store); }
  const shared = store;
  useEffect(() => shared.mount(), [shared]);
  useEffect(() => showUsage ? shared.watchUsage() : undefined, [shared, showUsage]);
  return { ...useSyncExternalStore(shared.subscribe, shared.get), refresh: () => shared.refresh(true, true), watchUsage: shared.watchUsage };
}
