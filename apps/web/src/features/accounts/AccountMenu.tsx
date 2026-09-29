import { useId, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Popover } from "@/components/Popover";
import type { ApiClient } from "@/lib/api";
import { BUILD_DETAIL, BUILD_LABEL } from "@/lib/build";
import type { AccountSummary, UsageWindow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { whoIs } from "./accountOf";
import { useAccountLogin } from "./AccountLogin";
import { AccountLogo } from "./AccountLogo";
import { accountOverview, quotaValue, resetText } from "./accountOverview";
import { useAccounts } from "./useAccounts";

export { resetText } from "./accountOverview";
export { AccountLogo } from "./AccountLogo";

/** The composer's quota card keeps its existing presentation; account details omit duplicate dates. */
export function Quota({ window: w, compact = false }: { window: UsageWindow; compact?: boolean }) {
  return <div className="space-y-2xs">
    <div className="flex items-center justify-between gap-sm text-xs"><span className="text-fg-secondary">{w.label}</span><span className="tabular-nums text-fg">{w.usedPercent != null && !w.unlimited ? "已用 " : ""}{quotaValue(w)}</span></div>
    {w.usedPercent != null && !w.unlimited && <div role="meter" aria-label={w.label} aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-2xs overflow-hidden rounded-full bg-bg-strong"><div className={cn("h-full rounded-full", w.usedPercent >= 90 ? "bg-danger" : "bg-brand")} style={{ width: `${w.usedPercent}%` }} /></div>}
    <div className="flex flex-wrap justify-between gap-2xs text-2xs text-fg-faint">
      {w.resetsAt ? <span title={new Date(w.resetsAt).toLocaleString()}>{resetText(w.resetsAt)}{!compact && <> · {new Date(w.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}</span> : !w.unlimited && !compact && <span>平台未提供重置时间</span>}
      {w.usedPercent != null && w.used != null && <span>{w.used.toLocaleString()} / {w.limit?.toLocaleString() ?? "—"} {w.unit}</span>}
    </div>
  </div>;
}

function AccountDetails({ account, manage }: { account: AccountSummary; manage: (id: AccountSummary["id"]) => void }) {
  return <div className="space-y-md px-md pb-md pt-xs">
    <div className="flex items-start justify-between gap-sm">
      <div className="min-w-0 text-xs text-fg-muted">
        <p className="truncate" title={whoIs(account)}>{whoIs(account) ?? (account.loggedIn ? "已登录" : "登录状态未知")}</p>
        {account.plan && <p className="mt-2xs text-2xs text-fg-faint">{account.plan}</p>}
      </div>
      <button type="button" onClick={() => manage(account.id)} className="flex-none rounded-sm text-xs text-fg-muted hover:text-fg">管理账号</button>
    </div>
    {account.method ? <p className="text-xs text-fg-muted">{account.method} · 使用该渠道计费，不显示订阅额度</p> : account.loggedIn && <>
      {account.usage?.status === "ready" ? <div className="space-y-md">
        {account.usage.windows.map(window => <Quota key={window.id} window={window} compact />)}
        {account.usage.balance && <p className="text-xs text-fg-muted">{account.usage.balance}</p>}
        {!account.usage.windows.length && !account.usage.balance && <p className="text-xs text-fg-muted">用量暂不可用</p>}
      </div> : <p className="text-xs text-fg-muted">{account.usage?.message ?? "尚未读取额度"}</p>}
      {account.usage?.fetchedAt && <p className="text-2xs text-fg-faint" title={new Date(account.usage.fetchedAt).toLocaleString()}>{new Date(account.usage.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 更新</p>}
    </>}
  </div>;
}

export function AccountRow({ account, expanded, toggle, manage }: {
  account: AccountSummary;
  expanded: boolean;
  toggle: () => void;
  /** Login/reauth enters the owner's account flow; authentication is not implemented here. */
  manage: (id: AccountSummary["id"]) => void;
}) {
  const detailId = useId();
  const overview = accountOverview(account);
  // Two accounts of one platform are told apart by who is signed in.
  const name = whoIs(account) != null ? `${account.name} · ${whoIs(account)}` : account.name;
  const canExpand = overview.action === "details";
  const open = canExpand && expanded;
  return <section>
    <button type="button"
      aria-label={`${name}：${overview.label}，${canExpand ? (open ? "收起详情" : "查看详情") : "登录"}`}
      aria-expanded={canExpand ? open : undefined}
      aria-controls={open ? detailId : undefined}
      onClick={() => { if (canExpand) toggle(); else manage(account.id); }}
      className="flex min-h-row w-full items-center gap-xs rounded-sm px-sm py-sm text-left hover:bg-bg-hover focus-visible:outline focus-visible:outline-brand">
      <AccountLogo kind={account.kind} className="size-md text-fg-muted" />
      <span className="max-w-[45%] flex-none truncate text-xs font-medium text-fg" title={name}>{name}</span>
      <span title={overview.label} className={cn("min-w-0 flex-1 truncate text-right text-xs tabular-nums", overview.tone === "danger" ? "text-danger" : overview.tone === "warning" ? "text-warning" : "text-fg-muted")}>{overview.label}</span>
      <ChevronRight aria-hidden className={cn("size-sm flex-none text-fg-faint", open && "rotate-90")} />
    </button>
    {open && <div id={detailId} role="region" aria-label={`${name}用量详情`}><AccountDetails account={account} manage={manage} /></div>}
  </section>;
}

type AccountPanelProps = ReturnType<typeof useAccounts> & {
  manage: (id: AccountSummary["id"]) => void;
  remote: boolean;
};

export function AccountPanel({ snapshot, refreshing, error, refresh, manage, remote }: AccountPanelProps) {
  const [expanded, setExpanded] = useState<AccountSummary["id"] | null>(null);
  const login = useAccountLogin();
  return <div className="flex max-h-[min(38rem,calc(100dvh-var(--spacing-3xl)))] flex-col" aria-label="账号用量">
    <div className="flex flex-none items-center gap-sm px-md py-sm">
      <span className="flex-1 font-medium text-body">账号用量</span>
      <span className="text-2xs text-fg-faint" title="百分比均表示已使用的额度">已用</span>
      <button type="button" aria-label="刷新账号与用量" title="刷新账号与用量" aria-busy={refreshing} disabled={refreshing} onClick={() => void refresh()} className="grid size-xl place-items-center rounded-md text-fg-muted hover:bg-bg-hover disabled:opacity-50"><RefreshCw className={cn("size-md", refreshing && "animate-spin")} /></button>
    </div>
    <div className="min-h-0 overflow-y-auto px-2xs pb-2xs">
      {error && <p role="status" className="px-sm py-xs text-xs text-warning">{error}{snapshot && !error.includes("上次结果") ? "，仍显示上次结果" : ""}</p>}
      {!snapshot && refreshing && <p className="px-sm py-sm text-xs text-fg-muted">正在读取账号与用量…</p>}
      {snapshot?.accounts.map(account => <AccountRow key={account.id} account={account} expanded={expanded === account.id} toggle={() => setExpanded(current => current === account.id ? null : account.id)} manage={manage} />)}
      {snapshot?.accounts.length === 0 && !remote && <div className="flex items-center justify-between gap-sm px-sm py-sm text-xs text-fg-muted">
        还没有账号
        <button type="button" onClick={() => login()} className="rounded-sm text-fg-muted hover:text-fg">添加账号</button>
      </div>}
    </div>
    {remote && <p className="flex-none px-md pb-sm text-2xs text-fg-faint">此处为远程主机的账号</p>}
  </div>;
}

export function AccountMenu({ client, connected, onManage }: { client: ApiClient; connected: boolean; onManage: (id: AccountSummary["id"]) => void }) {
  // Keep polling even with the popover closed or no task selected.
  const accounts = useAccounts(client);
  return <Popover side="top" popupRole="dialog" ariaLabel="账号用量" className="w-figure max-w-[calc(100vw-var(--spacing-lg))] p-0" trigger={props => <button {...props} type="button" aria-label="账号用量" className="group/account-menu flex min-w-0 flex-1 items-center gap-sm rounded-md py-2xs text-left hover:bg-bg-hover">
    <span aria-hidden className="isolate flex flex-none -space-x-sm items-center text-fg-muted">
      {(["github", "codex", "claude"] as const).map(kind => <span key={kind} className="relative rounded-full bg-bg-sidebar">
        <span className="flex rounded-full p-3xs group-hover/account-menu:bg-bg-hover"><AccountLogo kind={kind} className="size-lg" /></span>
      </span>)}
    </span>
    <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-body text-fg">账号用量</span><span title={BUILD_DETAIL} className={cn("truncate text-2xs", connected ? "text-fg-faint" : "text-danger")}>{connected ? BUILD_LABEL : "连接断开"}</span></span>
  </button>}>{close => <AccountPanel {...accounts} remote={client.remoteSession} manage={id => { close(); onManage(id); }} />}</Popover>;
}
