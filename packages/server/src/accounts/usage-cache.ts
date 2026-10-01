import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../store/atomic-file.js";
import type { AccountKind, AccountSummary, AccountUsage } from "./types.js";
import { unavailable, UsageError } from "./usage.js";

/** Product limits, not claims about a vendor's safe request rate. */
export const USAGE_FALLBACK_INTERVAL = 15 * 60_000;
export const USAGE_RATE_LIMIT_COOLDOWN = 30 * 60_000;
type Entry = { nextAt: number; usage?: AccountUsage };
type Cooldown = { until: number; failures: number };
type File = { version: 1; entries: Record<string, Entry>; cooldowns: Partial<Record<AccountKind, Cooldown>> };
const identity = (account: AccountSummary) => createHash("sha256").update(JSON.stringify([account.kind, account.id, account.email, account.username, account.method])).digest("hex");

/** Serializes read/reserve/write across services sharing this data directory. No credential is stored. */
const chains = new Map<string, Promise<unknown>>();
export function createUsageCache(dataDir: string) {
  const path = join(dataDir, "account-usage.json");
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(path) ?? Promise.resolve()).then(fn, fn);
    chains.set(path, next.catch(() => {}));
    return next;
  };
  const read = async (): Promise<File> => {
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (text == null) return { version: 1, entries: {}, cooldowns: {} };
    const file = JSON.parse(text) as File;
    // Fail closed: a corrupt/missing cooldown cannot authorize repeated upstream requests.
    if (file.version !== 1 || !file.entries || !file.cooldowns) throw new Error("Invalid account usage cache");
    for (const entry of Object.values(file.entries)) {
      if (!Number.isFinite(entry.nextAt) || (entry.usage != null && (!Array.isArray(entry.usage.windows) || !Number.isFinite(Date.parse(entry.usage.fetchedAt))))) throw new Error("Invalid account usage entry");
    }
    for (const cooldown of Object.values(file.cooldowns)) if (!Number.isFinite(cooldown.until) || !Number.isFinite(cooldown.failures)) throw new Error("Invalid account usage cooldown");
    return file;
  };
  const write = async (file: File) => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path, file, { mode: 0o600 });
  };
  const view = (entry: Entry | undefined, cooldown?: Cooldown): AccountUsage | undefined => {
    if (cooldown && cooldown.until > Date.now()) return {
      ...(entry?.usage ?? unavailable(new UsageError(429))),
      message: "平台已限制额度查询，冷却期间不会补查；对话中的额度仍可更新",
      retryAt: new Date(cooldown.until).toISOString(),
    };
    return entry?.usage;
  };
  const merge = (before: AccountUsage | undefined, update: AccountUsage): AccountUsage => {
    const windows = new Map((before?.windows ?? []).map(w => [w.id, w]));
    for (const w of update.windows) windows.set(w.id, { ...w, observedAt: update.fetchedAt });
    const balance = update.balance ?? before?.balance;
    return { ...update, windows: [...windows.values()], ...(balance != null ? { balance } : {}) };
  };
  return {
    peek: (account: AccountSummary): Promise<AccountUsage | undefined> => serialize(async () => {
      const file = await read();
      return view(file.entries[identity(account)], file.cooldowns[account.kind]);
    }),
    observe: (account: AccountSummary, usage: AccountUsage): Promise<void> => serialize(async () => {
      if (usage.status !== "ready") return;
      const file = await read(), key = identity(account), previous = file.entries[key];
      file.entries[key] = { nextAt: previous?.nextAt ?? 0, usage: merge(previous?.usage, { ...usage, source: "conversation" }) };
      // Passive recovery does not lift a quota-endpoint cooldown.
      await write(file);
    }),
    query: (account: AccountSummary, fetchUsage: () => Promise<AccountUsage | undefined>): Promise<AccountUsage | undefined> => serialize(async () => {
      const file = await read(), key = identity(account), previous = file.entries[key];
      const now = Date.now(), cooldown = file.cooldowns[account.kind];
      if (cooldown && cooldown.until > now) return view(previous, cooldown);
      if (previous && (previous.nextAt > now || (previous.usage?.status === "ready" && now - Date.parse(previous.usage.fetchedAt) < USAGE_FALLBACK_INTERVAL))) return previous.usage;
      // Reserve durably BEFORE touching a credential or making a request. Refresh, account
      // settings, multiple windows and server restarts cannot bypass this reservation.
      file.entries[key] = { ...previous, nextAt: now + USAGE_FALLBACK_INTERVAL };
      await write(file);
      let usage: AccountUsage | undefined;
      try {
        usage = await fetchUsage();
        if (usage) usage = { ...usage, source: "query", windows: usage.windows.map(w => ({ ...w, observedAt: usage!.fetchedAt })) };
        if (usage?.status === "ready") delete file.cooldowns[account.kind];
      } catch (error) {
        usage = unavailable(error);
        if (error instanceof UsageError && error.status === 429) {
          const failures = (cooldown?.failures ?? 0) + 1;
          const until = Math.max(error.retryAt ?? 0, Date.now() + Math.min(6 * 60 * 60_000, USAGE_RATE_LIMIT_COOLDOWN * 2 ** Math.min(failures - 1, 4)));
          file.cooldowns[account.kind] = { failures, until };
          usage.retryAt = new Date(until).toISOString();
        }
      }
      if (usage?.status === "unavailable" && previous?.usage?.status === "ready") usage = { ...previous.usage, message: `${usage.message ?? "额度补查失败"}；显示上次结果`, ...(usage.retryAt ? { retryAt: usage.retryAt } : {}) };
      file.entries[key] = { nextAt: Date.now() + USAGE_FALLBACK_INTERVAL, ...(usage ? { usage } : {}) };
      await write(file);
      return view(file.entries[key], file.cooldowns[account.kind]);
    }),
  };
}
