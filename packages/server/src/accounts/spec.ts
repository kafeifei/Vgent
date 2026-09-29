import { randomBytes } from "node:crypto";
import type { AccountId, AccountKind } from "./types.js";

/**
 * How a model names the account it runs on. The first account of each
 * platform — the machine's own Claude / Codex login, the first GitHub one —
 * keeps the spelling tasks always had (`sonnet`, `gpt-5.5`,
 * `codex-subscription:gpt-5.5`, `github-copilot:gpt-4.1`), so nothing stored
 * has to change. Every other account puts itself in front: `@codex-1a2b3c4d:gpt-5.5`.
 * Each account's models are thereby rows of their own everywhere a model id is
 * a key — the picker, 隐藏的模型, 记住上次选择.
 */
export const DEFAULT_ACCOUNT: Record<AccountKind, AccountId> = { claude: "claude", codex: "codex", github: "github" };

const ACCOUNT_ID = /^(claude|codex|github)(?:-[0-9a-f]{8})?$/;
const ACCOUNT_SPEC = /^@((?:claude|codex|github)-[0-9a-f]{8}):(.+)$/;

export const isAccountId = (value: unknown): value is AccountId => typeof value === "string" && ACCOUNT_ID.test(value);

export function kindOfAccount(id: AccountId): AccountKind {
  const match = ACCOUNT_ID.exec(id);
  if (match == null) throw new Error(`Not an account id: ${id}`);
  return match[1] as AccountKind;
}

export const isDefaultAccount = (id: AccountId): boolean => isAccountId(id) && DEFAULT_ACCOUNT[kindOfAccount(id)] === id;

export const newAccountId = (kind: AccountKind): AccountId => `${kind}-${randomBytes(4).toString("hex")}`;

/** A model spec as `accountId` runs it. */
export const accountSpec = (accountId: AccountId, spec: string): string => (isDefaultAccount(accountId) ? spec : `@${accountId}:${spec}`);

/** The account a model spec names, and the spec as its engine knows it. No account means the platform's first. */
export function splitAccountSpec(model: string): { accountId?: AccountId; spec: string } {
  const match = ACCOUNT_SPEC.exec(model);
  return match == null ? { spec: model } : { accountId: match[1]!, spec: match[2]! };
}

/** The account a spec runs on, for a platform: its own prefix, else that platform's first account. */
export function accountOfSpec(model: string, kind: AccountKind): AccountId {
  const { accountId } = splitAccountSpec(model);
  return accountId != null && kindOfAccount(accountId) === kind ? accountId : DEFAULT_ACCOUNT[kind];
}

/**
 * What 提供商排序 and the provider page call an account that brings models.
 * The first account keeps the name the single login had.
 */
const LEGACY_KEY: Record<AccountKind, string> = { claude: "claude-subscription", codex: "codex-subscription", github: "github-copilot" };

export const subscriptionKey = (accountId: AccountId): string => {
  const legacy = LEGACY_KEY[kindOfAccount(accountId)];
  return isDefaultAccount(accountId) ? legacy : `${legacy}@${accountId}`;
};

export function accountOfSubscriptionKey(key: string): AccountId | undefined {
  for (const [kind, legacy] of Object.entries(LEGACY_KEY) as Array<[AccountKind, string]>) {
    if (key === legacy) return DEFAULT_ACCOUNT[kind];
    if (key.startsWith(`${legacy}@`)) {
      const id = key.slice(legacy.length + 1);
      return isAccountId(id) && kindOfAccount(id) === kind ? id : undefined;
    }
  }
  return undefined;
}

/** One key per model per account, whichever engine lists it. */
export const accountModelKey = (accountId: AccountId, model: string): string => `${subscriptionKey(accountId)}/${model}`;
