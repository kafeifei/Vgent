import type { AccountUsage, UsageWindow } from "./types.js";

export const object = (v: unknown): Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const time = (v: unknown): string | undefined => {
  const date = typeof v === "number" ? new Date(v * 1000) : typeof v === "string" ? new Date(v) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const percent = (v: unknown) => { const n = number(v); return n == null ? undefined : Math.max(0, Math.min(100, n)); };
const duration = (seconds: unknown, fallback: string) => {
  const n = number(seconds);
  return n === 604800 ? "每周" : n === 18000 ? "5 小时" : n ? `${Math.round(n / 3600)} 小时` : fallback;
};
function result(windows: UsageWindow[], balance?: string): AccountUsage {
  return { status: windows.length || balance ? "ready" : "unavailable", fetchedAt: new Date().toISOString(), windows, ...(balance ? { balance } : {}), ...(!windows.length && !balance ? { message: "平台没有返回可用额度" } : {}) };
}
export function parseCodexUsage(raw: unknown): AccountUsage {
  const data = object(raw);
  const windows: UsageWindow[] = [];
  const add = (id: string, label: string, raw: unknown) => {
    const limit = object(raw);
    for (const [key, fallback] of [["primary_window", "当前窗口"], ["secondary_window", "每周"]]) {
      const w = object(limit[key!]);
      const used = percent(w.used_percent);
      if (used != null) windows.push({ id: `${id}-${key}`, label: `${label}${duration(w.limit_window_seconds, fallback!)}`, usedPercent: used, ...(time(w.reset_at) ? { resetsAt: time(w.reset_at)! } : {}) });
    }
  };
  add("codex", "", data.rate_limit);
  add("review", "代码审查 · ", data.code_review_rate_limit);
  if (Array.isArray(data.additional_rate_limits)) for (const [i, entry] of data.additional_rate_limits.entries()) {
    const item = object(entry); add(`extra-${i}`, `${typeof item.limit_name === "string" ? item.limit_name : "额外额度"} · `, item.rate_limit);
  }
  const credits = object(data.credits);
  return result(windows, credits.unlimited === true ? "点数不限量" : typeof credits.balance === "string" || typeof credits.balance === "number" ? `可用点数 ${credits.balance}` : undefined);
}
export function parseClaudeUsage(raw: unknown): AccountUsage {
  const data = object(raw), windows: UsageWindow[] = [];
  const labels: Record<string, string> = { five_hour: "5 小时", seven_day: "每周", seven_day_sonnet: "Sonnet · 每周", seven_day_opus: "Opus · 每周", seven_day_oauth_apps: "OAuth 应用 · 每周", seven_day_cowork: "Cowork · 每周" };
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("five_hour") && !key.startsWith("seven_day")) continue;
    const w = object(value), used = percent(w.utilization);
    if (used != null) windows.push({ id: key, label: labels[key] ?? key.replaceAll("_", " "), usedPercent: used, ...(time(w.resets_at) ? { resetsAt: time(w.resets_at)! } : {}) });
  }
  const extra = object(data.extra_usage);
  if (extra.is_enabled === true && number(extra.used_credits) != null) windows.push({ id: "extra", label: "额外用量", used: number(extra.used_credits)! / 100, ...(number(extra.monthly_limit) != null ? { limit: number(extra.monthly_limit)! / 100 } : {}), unit: "USD", ...(percent(extra.utilization) != null ? { usedPercent: percent(extra.utilization)! } : {}) });
  return result(windows);
}
export function parseCopilotUsage(raw: unknown): AccountUsage {
  const data = object(raw), snapshots = object(data.quota_snapshots), windows: UsageWindow[] = [];
  const labels: Record<string, string> = { premium_interactions: "高级请求", chat: "聊天", completions: "代码补全" };
  const ordered = [...new Set(["premium_interactions", "chat", "completions", ...Object.keys(snapshots)])];
  for (const id of ordered) {
    const raw = snapshots[id];
    const w = object(raw), remaining = number(w.percent_remaining), limit = number(w.entitlement), left = number(w.remaining);
    if (w.unlimited !== true && remaining == null && (limit == null || limit <= 0 || left == null)) continue;
    windows.push({ id, label: labels[id] ?? id.replaceAll("_", " "), ...(w.unlimited === true ? { unlimited: true } : { usedPercent: percent(remaining != null ? 100 - remaining : 100 * (limit! - left!) / limit!)!, ...(limit != null && left != null ? { used: Math.max(0, limit - left), limit, unit: "次" } : {}) }), ...(time(data.quota_reset_date_utc ?? data.quota_reset_date) ? { resetsAt: time(data.quota_reset_date_utc ?? data.quota_reset_date)! } : {}) });
  }
  const premium = object(snapshots.premium_interactions);
  const credits = number(premium.credits_used);
  if (credits != null && credits > 0) windows.push({ id: "ai-credits", label: "AI 点数已用", used: credits, unit: "点" });
  return result(windows);
}
export class UsageError extends Error {
  constructor(readonly status: number, readonly retryAt?: number) { super("Account usage request failed"); }
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const at = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(at) && at > now ? at : undefined;
}
export async function accountJson(url: string, headers: Record<string, string>, fetcher = fetch): Promise<unknown> {
  const response = await fetcher(url, { headers, redirect: "error", signal: AbortSignal.timeout(12_000) });
  const retryAt = retryAfter(response.headers.get("retry-after"));
  const rateLimited = response.status === 429 || (response.status === 403 && (retryAt != null || response.headers.get("x-ratelimit-remaining") === "0"));
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
    throw new UsageError(rateLimited ? 429 : response.status, retryAt ?? (Number.isFinite(reset) && reset > Date.now() ? reset : undefined));
  }
  const data: unknown = await response.json();
  if (object(object(data).error).type === "rate_limit_error") throw new UsageError(429, retryAt);
  return data;
}
export function unavailable(error: unknown): AccountUsage {
  const reauth = error instanceof UsageError && [401, 403].includes(error.status);
  return { status: reauth ? "reauth" : "unavailable", fetchedAt: new Date().toISOString(), windows: [], message: reauth ? "当前登录无法读取额度，请检查账号权限或重新登录" : error instanceof UsageError && error.status === 429 ? "平台已限制额度查询，已暂停补查；对话中的额度仍可更新" : "暂时无法读取额度，已暂停补查" };
}

/** Subscription limits reported by the existing Claude Code conversation, not token counts. */
export function parseClaudeRateLimit(raw: unknown): AccountUsage | undefined {
  const info = object(raw), windows = object(info.unifiedWindows);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(windows)) {
    const w = object(value), used = number(w.utilization);
    if (used != null && used >= 0) data[key] = { utilization: used * 100, resets_at: w.resetsAt };
  }
  const kind = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const used = number(info.utilization);
  if (kind && data[kind] == null && used != null && used >= 0) data[kind] = { utilization: used * 100, resets_at: info.resetsAt };
  const usage = parseClaudeUsage(data);
  return usage.status === "ready" ? usage : undefined;
}

/** Sparse native app-server notification; missing windows must not become zero or erase old data. */
export function parseCodexRateLimit(raw: unknown): AccountUsage | undefined {
  const data = object(raw), windows: UsageWindow[] = [];
  const id = typeof data.limitId === "string" ? data.limitId : "codex";
  for (const [key, fallback] of [["primary", "当前窗口"], ["secondary", "每周"]] as const) {
    const w = object(data[key]), used = percent(w.usedPercent);
    if (used == null) continue;
    const minutes = number(w.windowDurationMins);
    windows.push({ id: `${id}-${key}_window`, label: `${id === "codex" ? "" : `${typeof data.limitName === "string" ? data.limitName : id} · `}${duration(minutes == null ? undefined : minutes * 60, fallback)}`, usedPercent: used, ...(time(w.resetsAt) ? { resetsAt: time(w.resetsAt)! } : {}) });
  }
  const credits = object(data.credits);
  const usage = result(windows, credits.unlimited === true ? "点数不限量" : typeof credits.balance === "string" ? `可用点数 ${credits.balance}` : undefined);
  return usage.status === "ready" ? usage : undefined;
}

export function parseCodexRateLimitHeaders(headers: Headers): AccountUsage | undefined {
  const numeric = (name: string) => { const value = headers.get(name); return value?.trim() ? number(Number(value)) : undefined; };
  return parseCodexRateLimit(Object.fromEntries(["primary", "secondary"].map(key => [key, {
    usedPercent: numeric(`x-codex-${key}-used-percent`), windowDurationMins: numeric(`x-codex-${key}-window-minutes`), resetsAt: numeric(`x-codex-${key}-reset-at`),
  }])));
}
