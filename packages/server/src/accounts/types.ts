export type AccountId = "github" | "codex" | "claude";
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
  name: string;
  loggedIn?: boolean;
  username?: string;
  email?: string;
  avatarUrl?: string;
  plan?: string;
  method?: string;
  engines: string[];
  usage?: AccountUsage;
}
export interface AccountSnapshot { accounts: AccountSummary[]; revision: number }
