import { afterEach, expect, it, vi } from "vitest";
import type { AccountSnapshot } from "@/lib/types";
import { accountsChanged, onAccountsChanged } from "@/lib/accountEvents";
import { createAccountStore } from "./accountStore";

const snapshot = (usedPercent = 20, email = "first@example.com"): AccountSnapshot => ({ revision: 1, accounts: [{
  id: "codex", name: "Codex", email, loggedIn: true, engines: ["Codex"],
  usage: { status: "ready", fetchedAt: new Date().toISOString(), windows: [{ id: "week", label: "每周", usedPercent }] },
}] });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("starts only a local snapshot read at app mount; extra consumers share it", async () => {
  const first = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockReturnValueOnce(first.promise) };
  const store = createAccountStore(client);
  const closeApp = store.mount();
  expect(client.getAccounts).toHaveBeenCalledExactlyOnceWith(false, false);
  expect(store.get()).toEqual({ refreshing: true, error: undefined });
  const closePanel = store.mount();
  const initialRead = store.refresh();
  first.resolve(snapshot()); await initialRead;
  closePanel();
  const closeReopenedPanel = store.mount();
  expect(store.get().snapshot?.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(20);
  expect(store.get().refreshing).toBe(false);
  expect(client.getAccounts).toHaveBeenCalledTimes(1);
  closeReopenedPanel(); closeApp();
});

it("polls only the local snapshot with the panel closed, preserving the old data until the new one arrives", async () => {
  vi.useFakeTimers();
  const next = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(next.promise) };
  const store = createAccountStore(client);
  const closeApp = store.mount();
  await store.refresh();
  const before = store.get().snapshot;
  await vi.advanceTimersByTimeAsync(59_999);
  expect(client.getAccounts).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(client.getAccounts).toHaveBeenNthCalledWith(2, false, false);
  expect(store.get().refreshing).toBe(true);
  expect(store.get().snapshot).toBe(before);
  const closePanel = store.mount();
  const reading = store.refresh(true);
  expect(client.getAccounts).toHaveBeenCalledTimes(2);
  next.resolve(snapshot(35)); await reading;
  expect(store.get().refreshing).toBe(false);
  expect(store.get().snapshot?.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(35);
  closePanel(); closeApp();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(client.getAccounts).toHaveBeenCalledTimes(2);
});

it("coalesces manual refreshes and keeps the last complete view if the refresh fails", async () => {
  const next = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(next.promise).mockRejectedValueOnce(Error("offline")) };
  const store = createAccountStore(client);
  await store.refresh();
  const before = store.get().snapshot;
  const read = store.refresh(true);
  expect(store.refresh(true)).toBe(read);
  expect(store.get().snapshot).toBe(before);
  next.resolve(snapshot(40)); await read;
  const complete = store.get().snapshot;
  await store.refresh(true);
  expect(store.get().snapshot).toBe(complete);
  expect(store.get().refreshing).toBe(false);
  expect(store.get().error).toBeTruthy();
});

it("replaces a switched account atomically and ignores late results from the previous login", async () => {
  const old = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot(5, "new@example.com")) };
  const store = createAccountStore(client);
  const closeApp = store.mount();
  const changed = vi.fn(); onAccountsChanged(client, changed);
  await store.refresh();
  const before = store.get().snapshot;
  const pending = store.refresh(true);
  expect(store.get().snapshot).toBe(before);
  accountsChanged(client); await store.refresh();
  old.resolve(snapshot()); await pending;
  expect(store.get().snapshot?.accounts[0]?.email).toBe("new@example.com");
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith("snapshot");
  expect(client.getAccounts).toHaveBeenCalledTimes(3);
  closeApp();
});


it("keeps a platform's last successful quota on an upstream error but never after its account changes", async () => {
  const unavailable = (email = "first@example.com"): AccountSnapshot => ({ revision: 1, accounts: [{
    id: "codex", name: "Codex", email, loggedIn: true, engines: ["Codex"],
    usage: { status: "unavailable", fetchedAt: new Date().toISOString(), windows: [], message: "offline" },
  }] });
  const client = { getAccounts: vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(unavailable("new@example.com")) };
  const store = createAccountStore(client);
  await store.refresh();
  const before = store.get().snapshot?.accounts[0]?.usage;
  await store.refresh(true);
  expect(store.get().snapshot?.accounts[0]?.usage).toEqual({ ...before, message: "offline" });
  expect(store.get().error).toContain("上次结果");
  await store.refresh(true);
  expect(store.get().snapshot?.accounts[0]?.usage?.status).toBe("unavailable");
  expect(store.get().snapshot?.accounts[0]?.email).toBe("new@example.com");
});

it("requests guarded fallback only while a quota surface is visible or on explicit refresh", async () => {
  vi.useFakeTimers();
  const client = { getAccounts: vi.fn().mockResolvedValue(snapshot()) };
  const store = createAccountStore(client);
  const unmount = store.mount();
  await store.refresh();
  expect(client.getAccounts).toHaveBeenLastCalledWith(false, false);
  const close = store.watchUsage();
  await store.refresh();
  expect(client.getAccounts).toHaveBeenLastCalledWith(true, false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.getAccounts).toHaveBeenLastCalledWith(true, false);
  close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.getAccounts).toHaveBeenLastCalledWith(false, false);
  await store.refresh(true, true);
  expect(client.getAccounts).toHaveBeenLastCalledWith(true, true);
  unmount();
});

it("does not run a deferred fallback after its quota panel was closed", async () => {
  const first = deferred<AccountSnapshot>();
  const client = { getAccounts: vi.fn().mockReturnValueOnce(first.promise) };
  const store = createAccountStore(client);
  const unmount = store.mount();
  const close = store.watchUsage();
  close();
  first.resolve(snapshot());
  await store.refresh();
  expect(client.getAccounts).toHaveBeenCalledExactlyOnceWith(false, false);
  unmount();
});
