import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createGitHubClient, type GitHubAuthorization, type GitHubCredential } from "../remote/github.js";
import type { AccountRegistry } from "./registry.js";
import { DEFAULT_ACCOUNT, newAccountId } from "./spec.js";
import type { AccountId } from "./types.js";

const exec = promisify(execFile);

export interface GitHubIdentity { id: number; name: string; username: string; avatarUrl: string }
/** What a consumer of one GitHub account gets: never serialized into a response. */
export interface GitHubAccess { accessToken: string; accountId: string; revision: number }

type SecurityCommand = (args: string[], input?: string) => Promise<string>;
type GitHubClient = ReturnType<typeof createGitHubClient>;

/**
 * GitHub accounts are Vgent's own: a device login, kept in one application
 * keychain item per account. The service name is the one remote access used
 * when there was a single login, and the first account keeps its item under
 * the same keychain account name (`github`), so nothing moves.
 */
export function createGitHubAccounts(options: {
  dataDir: string;
  registry: AccountRegistry;
  command?: SecurityCommand;
  client?: GitHubClient;
  clientId?: string;
  platform?: NodeJS.Platform;
}) {
  const command = options.command ?? security;
  const client = options.client ?? createGitHubClient();
  const clientId = options.clientId ?? process.env.VGENT_GITHUB_CLIENT_ID;
  const withClient = <T extends object>(input: T): T & { clientId?: string } => (clientId ? { ...input, clientId } : input);
  const service = `dev.vgent.remote.${createHash("sha256").update(options.dataDir).digest("hex").slice(0, 24)}`;
  const available = () => (options.platform ?? process.platform) === "darwin";

  const credentials = new Map<AccountId, GitHubCredential>();
  const identities = new Map<AccountId, GitHubIdentity>();
  const refreshes = new Map<AccountId, Promise<GitHubCredential>>();
  /** Bumped when an account signs out, so a late refresh cannot bring it back. */
  const revisions = new Map<AccountId, number>();
  const revisionOf = (id: AccountId) => revisions.get(id) ?? 0;

  const readStored = async (id: AccountId): Promise<GitHubCredential | undefined> => {
    if (!available()) throw new Error("GitHub credential storage unavailable");
    let encoded: string;
    try {
      encoded = (await command(["find-generic-password", "-a", id, "-s", service, "-w"])).trim();
    } catch (error) {
      if ((error as { code?: number }).code === 44) return undefined;
      throw new Error("GitHub credential storage unavailable");
    }
    return decodeCredential(encoded);
  };
  const writeStored = async (id: AccountId, value: GitHubCredential) => {
    if (!available()) throw new Error("GitHub credential storage unavailable");
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
    // The password goes over stdin to security's command reader: argv would show it in process listings.
    await command(["-i"], `add-generic-password -U -a ${id} -s ${service} -w ${encoded}\n`).catch(() => {
      throw new Error("GitHub credential storage unavailable");
    });
    // The interactive command can succeed with a failed subcommand; confirm what was saved.
    const saved = await readStored(id);
    if (saved?.accessToken !== value.accessToken || saved.refreshToken !== value.refreshToken) throw new Error("GitHub credential was not saved");
  };
  const clearStored = async (id: AccountId) => {
    try { await command(["delete-generic-password", "-a", id, "-s", service]); }
    catch (error) { if ((error as { code?: number }).code !== 44) throw new Error("GitHub credential storage unavailable"); }
  };

  /** The account's token, refreshed and written back when it is about to expire. */
  const token = async (id: AccountId): Promise<string> => {
    const revision = revisionOf(id);
    let credential = credentials.get(id);
    if (credential == null) {
      // A locked keychain can show a dialog: read once per account, not per poll.
      credential = await readStored(id);
      if (revision !== revisionOf(id)) throw new Error("GitHub account changed");
      if (credential == null) throw new Error("GitHub account is not signed in");
      credentials.set(id, credential);
    }
    if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential.accessToken;
    let pending = refreshes.get(id);
    if (pending == null) {
      const current = credential;
      pending = client.refreshGitHubCredential(current, withClient({})).then(async (next) => {
        if (revision !== revisionOf(id)) throw new Error("GitHub account changed");
        await writeStored(id, next);
        if (revision !== revisionOf(id)) throw new Error("GitHub account changed");
        credentials.set(id, next);
        return next;
      }).finally(() => refreshes.delete(id));
      refreshes.set(id, pending);
    }
    return (await pending).accessToken;
  };

  const identity = async (id: AccountId): Promise<GitHubIdentity> => {
    const known = identities.get(id);
    if (known != null) return known;
    const revision = revisionOf(id);
    const found = await client.getGitHubAccount(await token(id));
    if (revision !== revisionOf(id)) throw new Error("GitHub account changed");
    const next = { ...found, avatarUrl: `https://avatars.githubusercontent.com/u/${found.id}?s=80` };
    identities.set(id, next);
    return next;
  };

  return {
    available,
    token,
    identity,
    /** For the account adapters (Copilot, quota): checked against the account's revision on every use. */
    async access(id: AccountId): Promise<GitHubAccess> {
      const revision = revisionOf(id);
      const accessToken = await token(id);
      const who = await identity(id);
      if (revision !== revisionOf(id)) throw new Error("GitHub account changed");
      return { accessToken, accountId: String(who.id), revision };
    },
    revision: revisionOf,
    /**
     * Starts a device login. `authorization` is the code to show; `done` settles
     * with the account the login produced — the one already there when the same
     * GitHub user signs in twice.
     */
    async beginLogin(signal: AbortSignal): Promise<{ authorization: GitHubAuthorization; done: Promise<{ id: AccountId; existing: boolean }> }> {
      if (!available()) throw new Error("GitHub credential storage unavailable");
      const authorization = await client.beginGitHubLogin(withClient({ signal }));
      const done = (async () => {
        const credential = await client.waitGitHubLogin(authorization, withClient({ signal }));
        const who = await client.getGitHubAccount(credential.accessToken, { signal });
        signal.throwIfAborted();
        const records = (await options.registry.list()).filter((record) => record.kind === "github");
        let existing: AccountId | undefined;
        for (const record of records) {
          const known = await identity(record.id).catch(() => undefined);
          if (known?.id === who.id) { existing = record.id; break; }
        }
        // Signing in again as someone already here renews that account's login.
        const id = existing ?? (records.some((record) => record.id === DEFAULT_ACCOUNT.github) ? newAccountId("github") : DEFAULT_ACCOUNT.github);
        signal.throwIfAborted();
        await writeStored(id, credential);
        credentials.set(id, credential);
        identities.set(id, { ...who, avatarUrl: `https://avatars.githubusercontent.com/u/${who.id}?s=80` });
        await options.registry.add({ id, kind: "github" });
        return { id, existing: existing != null };
      })();
      return { authorization, done };
    },
    async signOut(id: AccountId): Promise<void> {
      revisions.set(id, revisionOf(id) + 1);
      credentials.delete(id);
      identities.delete(id);
      await refreshes.get(id)?.catch(() => undefined);
      if (available()) await clearStored(id);
    },
    /** Forget what was read, so the next use goes back to the keychain. */
    reload(id: AccountId) { credentials.delete(id); identities.delete(id); },
  };
}

export type GitHubAccounts = ReturnType<typeof createGitHubAccounts>;

async function security(args: string[], input?: string): Promise<string> {
  if (input === undefined) return (await exec("/usr/bin/security", args, { timeout: 30_000 })).stdout;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "ignore", "pipe"], timeout: 30_000 });
    let failed = false;
    child.stderr.on("data", (data: Buffer) => { if (data.toString().includes("SecKeychain")) failed = true; });
    child.on("error", () => reject(new Error("GitHub credential storage unavailable")));
    child.on("close", (code) => code === 0 && !failed ? resolve("") : reject(new Error("GitHub credential storage unavailable")));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function decodeCredential(encoded: string): GitHubCredential {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
  catch { throw new Error("Invalid GitHub credential"); }
  if (!value || typeof value !== "object" || !("accessToken" in value) || typeof value.accessToken !== "string" || !value.accessToken) throw new Error("Invalid GitHub credential");
  if ("expiresAt" in value && (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt))) throw new Error("Invalid GitHub credential");
  if ("refreshToken" in value && typeof value.refreshToken !== "string") throw new Error("Invalid GitHub credential");
  return value as GitHubCredential;
}
