import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJsonOrQuarantine, writeJsonAtomic } from "../store/atomic-file.js";
import type { Logger } from "../types.js";
import { silentLogger } from "../types.js";
import { DEFAULT_ACCOUNT, isAccountId, kindOfAccount } from "./spec.js";
import type { AccountId, AccountKind, AccountUse } from "./types.js";

/**
 * The accounts the user added, in `<dataDir>/accounts.json`: which ones, in
 * what order, and what each is switched on for. Never a credential — those
 * stay with their owners (the vendor CLI's store, Vgent's keychain item).
 *
 * The machine's own Claude and Codex logins need no record to exist: they are
 * accounts whenever the CLI says it is signed in. A record for one only keeps
 * its switches.
 */
export interface AccountRecord {
  id: AccountId;
  kind: AccountKind;
  /** Switched off uses; anything absent is on. `remote` is never kept here. */
  uses?: Partial<Record<AccountUse, boolean>>;
  addedAt: string;
}

interface AccountsFile { version: 1; accounts: AccountRecord[] }

const isRecordShape = (value: unknown): value is AccountRecord => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as AccountRecord;
  return isAccountId(record.id) && kindOfAccount(record.id) === record.kind && typeof record.addedAt === "string";
};
const isAccountsFile = (value: unknown): value is AccountsFile =>
  typeof value === "object" && value !== null && Array.isArray((value as AccountsFile).accounts) && (value as AccountsFile).accounts.every(isRecordShape);

/** Where an account the machine's CLI does not own keeps its login: `<dataDir>/accounts/<id>`. */
export const accountHome = (dataDir: string, id: AccountId): string => join(dataDir, "accounts", id);

export interface AccountRegistry {
  list(): Promise<AccountRecord[]>;
  get(id: AccountId): Promise<AccountRecord | undefined>;
  /** Adds the record, or keeps the one already there. */
  add(record: Omit<AccountRecord, "addedAt">): Promise<AccountRecord>;
  remove(id: AccountId): Promise<void>;
  setUse(id: AccountId, use: AccountUse, enabled: boolean): Promise<AccountRecord>;
}

/** One write chain per file, however many registries a process opens on it. */
const chains = new Map<string, Promise<unknown>>();

export function createAccountRegistry(dataDir: string, log: Logger = silentLogger): AccountRegistry {
  const path = join(dataDir, "accounts.json");
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = (chains.get(path) ?? Promise.resolve()).then(work, work);
    chains.set(path, next.catch(() => {}));
    return next;
  };

  /**
   * Before multiple accounts, the one GitHub login lived with 远程访问. Its
   * keychain item already sits where the first GitHub account's goes, so the
   * record is all a first read has to add.
   */
  const seed = async (): Promise<AccountRecord[]> => {
    const raw = await readFile(join(dataDir, "remote", "settings.json"), "utf8").catch(() => undefined);
    if (raw == null) return [];
    try {
      const remote = JSON.parse(raw) as Record<string, unknown>;
      return remote.remoteCredentialSaved === true ? [{ id: DEFAULT_ACCOUNT.github, kind: "github", addedAt: new Date(0).toISOString() }] : [];
    } catch {
      return [];
    }
  };

  const read = async (): Promise<AccountRecord[]> => {
    const file = await readJsonOrQuarantine<AccountsFile>(path, { validate: isAccountsFile, log });
    return file?.accounts ?? (await seed());
  };
  const write = async (accounts: AccountRecord[]) => {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path, { version: 1, accounts } satisfies AccountsFile, { mode: 0o600 });
  };

  return {
    list: () => serialize(read),
    get: (id) => serialize(async () => (await read()).find((record) => record.id === id)),
    add: (input) => serialize(async () => {
      const accounts = await read();
      const existing = accounts.find((record) => record.id === input.id);
      if (existing != null) return existing;
      const record: AccountRecord = { ...input, addedAt: new Date().toISOString() };
      await write([...accounts, record]);
      return record;
    }),
    remove: (id) => serialize(async () => {
      const accounts = await read();
      if (accounts.some((record) => record.id === id)) await write(accounts.filter((record) => record.id !== id));
    }),
    setUse: (id, use, enabled) => serialize(async () => {
      const accounts = await read();
      const current = accounts.find((record) => record.id === id) ?? { id, kind: kindOfAccount(id), addedAt: new Date().toISOString() };
      const { [use]: _previous, ...others } = current.uses ?? {};
      const uses = enabled ? others : { ...others, [use]: false };
      const next: AccountRecord = { id: current.id, kind: current.kind, addedAt: current.addedAt, ...(Object.keys(uses).length > 0 ? { uses } : {}) };
      await write(accounts.some((record) => record.id === id) ? accounts.map((record) => (record.id === id ? next : record)) : [...accounts, next]);
      return next;
    }),
  };
}

/** Whether a record leaves `use` on. No record, nothing switched off. */
export const useEnabled = (record: AccountRecord | undefined, use: AccountUse): boolean => record?.uses?.[use] !== false;
