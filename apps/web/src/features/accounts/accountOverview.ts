import type { AccountSummary, UsageWindow } from "@/lib/types";

const PRIMARY_WINDOWS: Record<AccountSummary["kind"], readonly string[]> = {
  github: ["premium_interactions"],
  codex: ["codex-primary_window", "codex-secondary_window"],
  claude: ["five_hour", "seven_day"],
};

/** Stable platform IDs, not upstream order or the fullest of unrelated quotas. */
export function primaryWindows(account: AccountSummary): UsageWindow[] {
  return PRIMARY_WINDOWS[account.kind].flatMap(id => {
    const window = account.usage?.windows.find(window => window.id === id);
    return window ? [window] : [];
  });
}

export function resetText(at: string, now = Date.now()): string {
  const delta = new Date(at).getTime() - now;
  if (!Number.isFinite(delta)) return "重置时间未知";
  if (delta <= 0) return "等待平台更新";
  const minutes = Math.ceil(delta / 60_000);
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后重置` : minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置` : `${minutes} 分钟后重置`;
}

export function quotaValue(window: UsageWindow): string {
  if (window.unlimited) return "不限量";
  if (window.usedPercent != null) return `${Number(window.usedPercent.toFixed(1))}%`;
  if (window.used != null) return `${window.used.toLocaleString()}${window.limit != null ? ` / ${window.limit.toLocaleString()}` : ""}${window.unit ? ` ${window.unit}` : ""}`;
  return "暂无数据";
}

type Overview = { action: "login" | "details"; label: string; tone: "normal" | "warning" | "danger" };

export function accountOverview(account: AccountSummary, now = Date.now()): Overview {
  if (account.loggedIn === false) return { action: "login", label: "未登录", tone: "normal" };
  if (account.usage?.status === "reauth") return { action: "login", label: "需重新登录", tone: "warning" };
  if (account.loggedIn !== true) return { action: "details", label: "登录状态未知", tone: "normal" };
  if (account.method) return { action: "details", label: account.method, tone: "normal" };
  if (account.usage?.status !== "ready") return { action: "details", label: "用量暂不可用", tone: "normal" };

  const windows = primaryWindows(account);
  const exhausted = windows.filter(window => !window.unlimited && (window.usedPercent ?? 0) >= 100);
  if (exhausted.length) {
    // Both windows can block usage: never suggest recovery at only the earlier reset.
    const latestReset = Math.max(...exhausted.map(window => Date.parse(window.resetsAt ?? "")));
    const reset = Number.isFinite(latestReset) ? resetText(new Date(latestReset).toISOString(), now) : "重置时间未知";
    return {
      action: "details", tone: "danger",
      label: `${exhausted.map(window => window.label).join(" / ")}已用尽 · ${exhausted.length > 1 && latestReset > now ? "最晚" : ""}${reset}`,
    };
  }
  const used = Math.max(0, ...windows.filter(window => !window.unlimited).map(window => window.usedPercent ?? 0));
  return {
    action: "details",
    label: windows.length ? windows.map(window => `${window.label} ${quotaValue(window)}`).join(" · ") : account.usage.windows.length || account.usage.balance ? "查看用量" : "用量暂不可用",
    tone: used >= 90 ? "danger" : used >= 80 ? "warning" : "normal",
  };
}
