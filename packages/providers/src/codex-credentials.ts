import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  getJwtExpiresAt,
  isAccessTokenExpiringSoon,
  isLinux,
  isMacOS,
  readLinuxSecretServicePassword,
  readMacOSKeychainPassword,
  refreshOAuthAccessToken,
} from "@ai-sdk/harness/utils";
import { isRecord, safeParseJSON } from "@ai-sdk/provider-utils";

/**
 * ChatGPT-backed Responses endpoint the Codex CLI talks to. Not the public
 * OpenAI API — it only accepts a ChatGPT subscription OAuth token.
 */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Same OAuth endpoint and client id the official Codex harness adapter uses. */
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CODEX_KEYRING_SERVICE = "Codex Auth";

/** Where a subscription credential was found. Never accompanied by the token. */
export type SubscriptionCredentialSource = "env" | "keychain" | "file";

export type CodexAuthStoreMode = "file" | "keyring" | "auto" | "ephemeral";

/** Overrides for tests; production callers pass nothing. */
export type CodexCredentialOptions = {
  /** Use this access token verbatim and never touch the local stores. */
  readonly accessToken?: string;
  /** ChatGPT account id sent as `chatgpt-account-id`, paired with `accessToken`. */
  readonly accountId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  /** Fetch used for the OAuth refresh call only. */
  readonly fetch?: typeof globalThis.fetch;
  readonly keyring?: CodexKeyring;
};

export type CodexKeyring = {
  read(options: { service: string; account: string }): Promise<string | undefined>;
  write(options: { service: string; account: string; value: string }): Promise<void>;
};

/** Resolved token handed to the request layer. Never logged, never persisted. */
export type CodexAccessToken = {
  readonly accessToken: string;
  readonly email?: string;
  readonly accountId: string | undefined;
  readonly expiresAt: number;
  readonly source: SubscriptionCredentialSource;
};

type CodexAuthValue = Record<string, unknown>;

type CodexAuthStore = {
  readonly source: Extract<SubscriptionCredentialSource, "file" | "keychain">;
  readonly value: CodexAuthValue;
  write(updated: CodexAuthValue): Promise<void>;
};

type CodexCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly accountId: string | undefined;
};

function resolveCodexHome(options: CodexCredentialOptions): string {
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  return resolve(env.CODEX_HOME ?? join(home, ".codex"));
}

/**
 * Mirrors the Codex harness adapter: only a top-level
 * `cli_auth_credentials_store` key counts, so parsing stops at the first table.
 */
async function readCodexAuthStoreMode(codexHome: string): Promise<CodexAuthStoreMode | undefined> {
  const text = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => undefined);
  if (text == null) return undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("[")) return undefined;
    const match = /^\s*cli_auth_credentials_store\s*=\s*["'](file|keyring|auto|ephemeral)["']\s*(?:#.*)?$/.exec(
      line,
    );
    const mode = match?.[1];
    if (mode != null) return mode as CodexAuthStoreMode;
  }
  return undefined;
}

export async function parseCodexAuthJson(text: string): Promise<CodexAuthValue | undefined> {
  const parsed = await safeParseJSON({ text });
  return parsed.success && isRecord(parsed.value) ? parsed.value : undefined;
}

/**
 * `auth.json` shape written by `codex login`:
 * `{ auth_mode: 'chatgpt', tokens: { access_token, refresh_token, account_id, id_token }, last_refresh }`.
 * Expiry is not stored — it comes from the access token's JWT `exp` claim.
 */
export async function toCodexCredential(value: CodexAuthValue): Promise<CodexCredential | undefined> {
  if (value.auth_mode !== "chatgpt" || !isRecord(value.tokens)) return undefined;
  const { access_token: accessToken, refresh_token: refreshToken, account_id: accountId } = value.tokens;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") return undefined;
  const expiresAt = await getJwtExpiresAt({ token: accessToken });
  if (expiresAt == null) return undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    accountId: typeof accountId === "string" ? accountId : undefined,
  };
}

async function writeCodexAuthFile(authPath: string, value: CodexAuthValue): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true });
  const temporaryPath = `${authPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, authPath);
}

function runWithInput(command: string, args: readonly string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, [...args], (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
    child.stdin?.end(input);
  });
}

export function createCodexKeyring(platform: NodeJS.Platform): CodexKeyring | undefined {
  if (isMacOS(platform)) {
    return {
      read: ({ service, account }) => readMacOSKeychainPassword({ service, account }),
      write: async ({ service, account, value }) => {
        // `-X <hex>` over stdin, like the Codex adapter: keeps the token out of argv.
        await runWithInput(
          "/usr/bin/security",
          ["-i"],
          `add-generic-password -U -s ${shellQuote(service)} -a ${shellQuote(account)} -X ${Buffer.from(
            value,
            "utf8",
          ).toString("hex")}\n`,
        );
      },
    };
  }
  if (isLinux(platform)) {
    return {
      read: ({ service, account }) =>
        readLinuxSecretServicePassword({ attributes: { service, username: account, target: "default" } }),
      write: async ({ service, account, value }) => {
        await runWithInput(
          "secret-tool",
          [
            "store",
            "--label",
            `${account}@${service}:default`,
            "service",
            service,
            "username",
            account,
            "target",
            "default",
            "application",
            "rust-keyring",
          ],
          value,
        );
      },
    };
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function codexKeyringAccount(codexHome: string): Promise<string> {
  const canonicalHome = await realpath(codexHome).catch(() => codexHome);
  return `cli|${createHash("sha256").update(canonicalHome).digest("hex").slice(0, 16)}`;
}

async function readCodexAuthStore(options: CodexCredentialOptions): Promise<CodexAuthStore | undefined> {
  const codexHome = resolveCodexHome(options);
  const authPath = join(codexHome, "auth.json");
  const mode = (await readCodexAuthStoreMode(codexHome)) ?? "file";
  if (mode === "ephemeral") return undefined;

  const readFileStore = async (): Promise<CodexAuthStore | undefined> => {
    const text = await readFile(authPath, "utf8").catch(() => undefined);
    if (text == null) return undefined;
    const value = await parseCodexAuthJson(text);
    if (value == null) return undefined;
    return { source: "file", value, write: (updated) => writeCodexAuthFile(authPath, updated) };
  };

  const readKeyringStore = async (): Promise<CodexAuthStore | undefined> => {
    const keyring = options.keyring ?? createCodexKeyring(options.platform ?? process.platform);
    if (keyring == null) return undefined;
    const account = await codexKeyringAccount(codexHome);
    const text = await keyring.read({ service: CODEX_KEYRING_SERVICE, account });
    if (text == null) return undefined;
    const value = await parseCodexAuthJson(text);
    if (value == null) return undefined;
    return {
      source: "keychain",
      value,
      write: (updated) =>
        keyring.write({ service: CODEX_KEYRING_SERVICE, account, value: JSON.stringify(updated) }),
    };
  };

  if (mode === "file") return readFileStore();
  if (mode === "keyring") return readKeyringStore();
  return (await readKeyringStore()) ?? (await readFileStore());
}

export class CodexSubscriptionAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSubscriptionAuthError";
  }
}

/**
 * Store-backed token owner: rereads the original login on each request so an
 * external CLI logout or account switch takes effect. Concurrent consumers
 * share one refresh and stale responses cannot restore a replaced login.
 */
export class CodexTokenProvider {
  readonly #options: CodexCredentialOptions;
  #revision = 0;
  #changing = false;
  #inflight: Promise<CodexAccessToken> | undefined;

  constructor(options: CodexCredentialOptions = {}) {
    this.#options = options;
  }

  async getAccessToken({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<CodexAccessToken> {
    if (this.#changing) throw new CodexSubscriptionAuthError("Codex account is changing");

    const inflight = this.#inflight;
    if (inflight != null) return inflight;

    const revision = this.#revision;
    const pending = this.#resolve(forceRefresh, revision);
    this.#inflight = pending;
    try {
      const token = await pending;
      if (revision !== this.#revision) throw new CodexSubscriptionAuthError("Codex account changed");
      return token;
    } finally {
      this.#inflight = undefined;
    }
  }

  /** Block consumers and drain refresh before the original CLI changes its store. */
  async changeAccount(action: () => Promise<void>): Promise<void> {
    if (this.#changing) throw new CodexSubscriptionAuthError("Codex account is changing");
    this.#changing = true;
    this.#revision++;
    try {
      await this.#inflight?.catch(() => undefined);
      await action();
    } finally { this.#changing = false; }
  }

  async #resolve(forceRefresh: boolean, revision: number): Promise<CodexAccessToken> {
    const supplied = this.#options.accessToken;
    if (supplied != null) {
      const expiresAt = (await getJwtExpiresAt({ token: supplied })) ?? Number.POSITIVE_INFINITY;
      return { accessToken: supplied, accountId: this.#options.accountId, expiresAt, source: "env" };
    }

    const stored = await readCodexAuthStore(this.#options);
    if (stored == null) {
      throw new CodexSubscriptionAuthError(
        `No Codex subscription credential found. Run \`codex login\` (looked in ${resolveCodexHome(
          this.#options,
        )}).`,
      );
    }
    const credential = await toCodexCredential(stored.value);
    if (credential == null) {
      throw new CodexSubscriptionAuthError(
        "Codex credential is not a ChatGPT subscription login (expected `auth_mode: \"chatgpt\"`).",
      );
    }

    if (!forceRefresh && !isAccessTokenExpiringSoon({ expiresAt: credential.expiresAt })) {
      return {
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        expiresAt: credential.expiresAt,
        source: stored.source,
        ...codexAccountOf(stored.value),
      };
    }

    const refreshed = await refreshOAuthAccessToken({
      tokenUrl: OPENAI_TOKEN_URL,
      clientId: OPENAI_CLIENT_ID,
      refreshToken: credential.refreshToken,
      requestFormat: "json",
      fetch: (input, init) => (this.#options.fetch ?? fetch)(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }),
    });
    // The CLI may have signed out or switched accounts during this network call.
    const current = await readCodexAuthStore(this.#options);
    const currentCredential = current == null ? undefined : await toCodexCredential(current.value);
    if (revision !== this.#revision || currentCredential?.accessToken !== credential.accessToken || currentCredential?.refreshToken !== credential.refreshToken) {
      throw new CodexSubscriptionAuthError("Codex account changed during refresh; retry with the current login");
    }
    const tokens = isRecord(stored.value.tokens) ? stored.value.tokens : {};
    await stored.write({
      ...stored.value,
      last_refresh: new Date().toISOString(),
      tokens: {
        ...tokens,
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken ?? credential.refreshToken,
      },
    });
    return {
      accessToken: refreshed.accessToken,
      accountId: credential.accountId,
      expiresAt: refreshed.expiresAt,
      source: stored.source,
      ...codexAccountOf(stored.value),
    };
  }
}

export type SubscriptionAuthStatus = {
  readonly available: boolean;
  readonly source: SubscriptionCredentialSource | null;
  readonly expiresAt?: number;
  /** Whose login this is and on which plan, so the settings page can say so. Never a token. */
  readonly email?: string;
  readonly plan?: string;
};

/**
 * The two claims of the login's `id_token` worth showing: the account's email
 * and `https://api.openai.com/auth`.`chatgpt_plan_type`. The token is only
 * decoded, never verified or kept — this names an account, it does not trust it.
 */
function codexAccountOf(value: CodexAuthValue): { email?: string; plan?: string } {
  const idToken = isRecord(value.tokens) ? value.tokens.id_token : undefined;
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  if (payload == null) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(claims)) return {};
    const auth = claims["https://api.openai.com/auth"];
    const plan = isRecord(auth) ? auth.chatgpt_plan_type : undefined;
    return {
      ...(typeof claims.email === "string" && claims.email !== "" ? { email: claims.email } : {}),
      ...(typeof plan === "string" && plan !== "" ? { plan } : {}),
    };
  } catch {
    return {};
  }
}

export type SubscriptionAuthReport = {
  readonly codex: SubscriptionAuthStatus;
};

/**
 * Reports whether a subscription login is usable, and where it lives — never
 * the token itself. Read-only: it does not refresh or write anything.
 */
export async function describeSubscriptionAuth(
  options: CodexCredentialOptions = {},
): Promise<SubscriptionAuthReport> {
  return { codex: await describeCodexAuth(options) };
}

async function describeCodexAuth(options: CodexCredentialOptions): Promise<SubscriptionAuthStatus> {
  try {
    const stored = await readCodexAuthStore(options);
    if (stored == null) return { available: false, source: null };
    const credential = await toCodexCredential(stored.value);
    if (credential == null) return { available: false, source: null };
    return { available: true, source: stored.source, expiresAt: credential.expiresAt, ...codexAccountOf(stored.value) };
  } catch {
    return { available: false, source: null };
  }
}

/** One refresh owner per original credential store, shared by quota, catalog and Engines. */
const sharedCodexTokens = new Map<string, CodexTokenProvider>();
export function getCodexTokenProvider(options: CodexCredentialOptions = {}): CodexTokenProvider {
  // Explicit injected transports/credentials belong to their caller (including tests).
  if (options.fetch || options.keyring || options.accessToken || options.platform) return new CodexTokenProvider(options);
  let key = resolveCodexHome(options);
  try { key = realpathSync(key); } catch { /* A missing home is handled by the owner. */ }
  let owner = sharedCodexTokens.get(key);
  if (!owner) { owner = new CodexTokenProvider({ ...options, env: { ...(options.env ?? process.env), CODEX_HOME: key } }); sharedCodexTokens.set(key, owner); }
  return owner;
}
