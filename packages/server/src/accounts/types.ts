/** The platforms an account can be on. Each can be signed in to more than once. */
export type AccountKind = "claude" | "codex" | "github";
/** An account's id: the machine's own logins are `claude` / `codex`, the first GitHub one `github`, the rest `<kind>-<hex>`. */
export type AccountId = string;
/**
 * What an account can be switched on for: its models — in the picker of
 * whichever engine runs them; the model decides that, not the account — and,
 * for GitHub, remote access. `remote` is not stored with the account: remote
 * access runs as one GitHub account at a time and keeps that choice itself.
 */
export type AccountUse = "models" | "remote";
export interface UsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  used?: number;
  limit?: number;
  unit?: string;
  unlimited?: boolean;
  resetsAt?: string;
}
export interface AccountUsage {
  status: "ready" | "unavailable" | "reauth";
  fetchedAt: string;
  windows: UsageWindow[];
  message?: string;
  balance?: string;
}
/** Public projection only: no credential, token, or grant is serializable here. */
export interface AccountSummary {
  id: AccountId;
  kind: AccountKind;
  name: string;
  loggedIn?: boolean;
  username?: string;
  email?: string;
  avatarUrl?: string;
  plan?: string;
  method?: string;
  /** The machine's own CLI login (`~/.claude`, `~/.codex`): signing out here signs the terminal out too. */
  machine?: boolean;
  /** What this account is switched on for, in the order the account page lists them. */
  uses: Array<{ id: AccountUse; enabled: boolean }>;
  usage?: AccountUsage;
}
export interface AccountSnapshot { accounts: AccountSummary[]; revision: number }

/** One sign-in in progress. Only one runs at a time. */
export interface AccountLoginAttempt {
  kind?: AccountKind;
  state: "idle" | "running" | "succeeded" | "failed";
  /** The vendor's authorization page, for Claude and Codex; the CLI opens it itself as well. */
  url?: string;
  /** GitHub's device login: the code to type, and where. */
  userCode?: string;
  verificationUri?: string;
  /** The account the login produced. */
  accountId?: AccountId;
  error?: string;
}

/** The uses each platform has, in display order. */
export const ACCOUNT_USES: Record<AccountKind, readonly AccountUse[]> = {
  claude: ["models"],
  codex: ["models"],
  github: ["models", "remote"],
};
