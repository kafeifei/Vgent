import { afterEach, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "@/lib/types";
import { onAccountsChanged } from "@/lib/accountEvents";
import { createAccountStore } from "./accountStore";

const snapshot = (email = "first@example.com", usage = false): AccountSnapshot => ({ revision: 1, accounts: [{
  id: "codex", name: "Codex", email, loggedIn: true, engines: ["Codex"],
  ...(usage ? { usage: { status: "ready" as const, fetchedAt: new Date().toISOString(), windows: [{ id: "week", label: "每周", usedPercent: 20 }] } } : {}),
}] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.restoreAllMocks());

it("waits for a complete quota snapshot, then reopens without refetching or losing quotas", async () => {
  const full = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(full.promise) };
  const store = createAccountStore(client);
  await store.refresh();
  const load = store.refresh(true);
  expect(store.get().usageSnapshot).toBeUndefined();
  full.resolve(snapshot(undefined, true)); await load;
  const complete = store.get().usageSnapshot;
  await store.refresh(true);
  expect(client.getAccounts).toHaveBeenCalledTimes(2);
  client.getAccounts.mockResolvedValueOnce(snapshot());
  await store.refresh(false, true);
  expect(store.get().usageSnapshot).toBe(complete);
});

it("coalesces duplicate refreshes and upgrades an in-flight identity request only once", async () => {
  const first = deferred<AccountSnapshot>(), full = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(full.promise) };
  const store = createAccountStore(client);
  const reads = [store.refresh(), store.refresh(true), store.refresh(true, true)];
  first.resolve(snapshot());
  await vi.waitFor(() => expect(client.getAccounts).toHaveBeenCalledTimes(2));
  full.resolve(snapshot(undefined, true)); await Promise.all(reads);
  expect(client.getAccounts).toHaveBeenNthCalledWith(2, true, false);
});

it("keeps the complete panel visible during refresh and ignores a late response from an old login", async () => {
  const old = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot(undefined, true)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot("new@example.com", true)) };
  const store = createAccountStore(client);
  const changed = vi.fn(); onAccountsChanged(client, changed);
  await store.refresh(true);
  const before = store.get().usageSnapshot;
  const pending = store.refresh(true, true);
  expect(store.get().usageSnapshot).toBe(before);
  store.invalidate(); await store.refresh(true, true);
  old.resolve(snapshot(undefined, true)); await pending;
  expect(store.get().usageSnapshot?.accounts[0]?.email).toBe("new@example.com");
  expect(changed).toHaveBeenCalledExactlyOnceWith("snapshot");
});

it("never associates old quotas with a changed identity and keeps data on transient errors", async () => {
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot(undefined, true)).mockRejectedValueOnce(Error("offline")).mockResolvedValueOnce(snapshot("new@example.com")) };
  const store = createAccountStore(client);
  await store.refresh(true);
  await store.refresh(true, true);
  expect(store.get().usageSnapshot?.accounts[0]?.usage?.windows).toHaveLength(1);
  expect(store.get().error).toBeTruthy();
  await store.refresh(false, true);
  expect(store.get().usageSnapshot).toBeUndefined();
  expect(store.get().snapshot?.accounts[0]?.email).toBe("new@example.com");
});
