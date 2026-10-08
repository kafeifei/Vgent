import type { AccountId, AccountKind, AccountSummary, EngineId, ModelEntry, UsageWindow } from "@/lib/types";

/**
 * The login a task's tokens are drawn from, read off the model row that runs
 * it: the account its source names — a Claude or Codex login, the GitHub
 * account behind Copilot. A provider's key or a gateway has no quota to show
 * and gets none. With no row to read (a harness left to pick its own default)
 * it is the engine's own login.
 */
export function accountOf(entry: Pick<ModelEntry, "source"> | undefined, engine: EngineId): AccountId | undefined {
  const source = entry?.source;
  if (source?.account != null) return source.account;
  if (source?.kind === "claude-subscription") return "claude";
  if (source?.kind === "codex-subscription") return "codex";
  if (source?.kind === "provider" && source.id === "github-copilot") return "github";
  if (source != null) return undefined;
  return engine === "claude-code" ? "claude" : engine === "codex" ? "codex" : undefined;
}

/** The platform an account id is on: `claude`, `codex-1a2b3c4d` → `codex`. */
export const kindOf = (id: AccountId): AccountKind => id.split("-")[0] as AccountKind;

export const ACCOUNT_NAMES: Record<AccountKind, string> = { claude: "Claude", codex: "Codex", github: "GitHub" };

/** Who is signed in, the way lists show it: the email, or the GitHub handle. */
export const whoIs = (account: Pick<AccountSummary, "email" | "username">): string | undefined =>
  account.email ?? (account.username != null ? `@${account.username}` : undefined);

/**
 * The account a task's own model runs on, from the spec alone — for when
 * there is no catalog row to read: `@<account>:` in front names it, and
 * otherwise it is the platform's first account, when the model is one of an
 * account's at all (a provider's `<provider>:<model>` is not).
 */
export function accountOfModel(engine: EngineId, model: string | undefined): AccountId | undefined {
  const spec = model ?? "";
  const prefixed = /^@((?:claude|codex|github)-[0-9a-f]{8}):/.exec(spec)?.[1];
  if (prefixed != null) return prefixed;
  // Copilot's on every engine that runs it.
  if (spec.startsWith("github-copilot:")) return "github";
  if (engine === "claude-code") return spec.includes(":") ? undefined : "claude";
  if (engine === "codex") return spec.includes(":") ? undefined : "codex";
  return spec === "" || spec.startsWith("codex-subscription:") ? "codex" : undefined;
}

/**
 * Whether a task stopped for want of an account: ours (「未登录」「需要重新登录」
 * 「账号已经移除」) or the vendor CLI's own words for a missing or expired login.
 */
export const isAccountFailure = (message: string): boolean =>
  /未登录|重新登录|账号已经移除|not logged in|please run \/login|oauth token has expired|invalid_grant|authentication_error|refresh token/i.test(message);

/** A model spec without the account in front: `@codex-1a2b3c4d:gpt-5.5` → `gpt-5.5`. */
export const bareSpec = (spec: string): string => spec.replace(/^@(?:claude|codex|github)-[0-9a-f]{8}:/, "");

/** The windows that can run out — an unlimited one never will — with the fullest first. */
export function meteredWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows
    .filter((window) => window.unlimited !== true && window.usedPercent != null)
    .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
}
