import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Popover } from "@/components/Popover";
import type { ApiClient } from "@/lib/api";
import { BUILD_DETAIL, BUILD_LABEL } from "@/lib/build";
import type { AccountSummary, UsageWindow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccounts } from "./useAccounts";

function AccountIcon({ account }: { account: Pick<AccountSummary, "id" | "avatarUrl"> }) {
  const [failed, setFailed] = useState<string>();
  return <span className="grid size-2xl flex-none place-items-center overflow-hidden rounded-full border-2 border-bg bg-bg-elevated text-fg shadow-sm">
    {account.avatarUrl && failed !== account.avatarUrl ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(account.avatarUrl)} className="size-full object-cover" /> : <span aria-hidden className="size-lg bg-current" style={{ mask: `url(/account-logos/${account.id}.svg) center / contain no-repeat`, WebkitMask: `url(/account-logos/${account.id}.svg) center / contain no-repeat` }} />}
  </span>;
}
export function resetText(at: string, now = Date.now()): string {
  const delta = new Date(at).getTime() - now;
  if (!Number.isFinite(delta)) return "重置时间未知";
  if (delta <= 0) return "等待平台更新";
  const minutes = Math.ceil(delta / 60_000);
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后重置` : minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置` : `${minutes} 分钟后重置`;
}
function Quota({ window: w }: { window: UsageWindow }) {
  return <div className="space-y-2xs">
    <div className="flex items-center justify-between gap-sm text-xs"><span className="text-fg-secondary">{w.label}</span><span className="tabular-nums text-fg">{w.unlimited ? "不限量" : w.usedPercent != null ? `已用 ${Number(w.usedPercent.toFixed(1))}%` : w.used != null ? `${w.used.toLocaleString()}${w.limit != null ? ` / ${w.limit.toLocaleString()}` : ""} ${w.unit ?? ""}` : "暂无数据"}</span></div>
    {w.usedPercent != null && !w.unlimited && <div role="meter" aria-label={w.label} aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100} className="h-2xs overflow-hidden rounded-full bg-bg-strong"><div className={cn("h-full rounded-full", w.usedPercent >= 90 ? "bg-danger" : "bg-brand")} style={{ width: `${w.usedPercent}%` }} /></div>}
    <div className="flex flex-wrap justify-between gap-2xs text-2xs text-fg-faint">
      {w.resetsAt ? <span title={new Date(w.resetsAt).toLocaleString()}>{resetText(w.resetsAt)} · {new Date(w.resetsAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> : !w.unlimited && <span>平台未提供重置时间</span>}
      {w.usedPercent != null && w.used != null && <span>{w.used.toLocaleString()} / {w.limit?.toLocaleString() ?? "—"} {w.unit}</span>}
    </div>
  </div>;
}
function AccountPanel({ client, manage }: { client: ApiClient; manage: (id: AccountSummary["id"]) => void }) {
  const { snapshot, loading, error, refresh } = useAccounts(client, true);
  const [expanded, setExpanded] = useState(false);
  return <div className="flex h-[min(38rem,calc(100dvh-var(--spacing-3xl)))] flex-col" aria-label="账号与用量">
    <div className="flex items-center justify-between px-md py-sm"><span className="font-medium text-body">账号与用量</span><button type="button" aria-label="刷新账号与用量" disabled={loading} onClick={() => void refresh()} className="grid size-xl place-items-center rounded-md text-fg-muted hover:bg-bg-hover disabled:opacity-50"><RefreshCw className={cn("size-md", loading && "animate-spin")} /></button></div>
    <div className="min-h-0 overflow-y-auto px-md">
      {error && <p role="status" className="py-sm text-xs text-danger">{error}</p>}
      {!snapshot && loading && <p className="py-lg text-xs text-fg-muted">正在读取账号与用量…</p>}
      {snapshot?.accounts.map(account => <section key={account.id} className="space-y-md border-t border-border py-md">
        <div className="flex items-center gap-sm"><AccountIcon account={account} /><div className="min-w-0 flex-1"><div className="flex items-center gap-xs text-body font-medium">{account.name}{account.plan && <span className="rounded-sm bg-bg-inset px-2xs text-2xs font-normal text-fg-muted">{account.plan}</span>}</div><p className="truncate text-xs text-fg-muted" title={account.email ?? account.username}>{account.username ? `@${account.username}` : account.email ?? (account.loggedIn === true ? "已登录" : account.loggedIn === false ? "未登录" : "无法确认登录状态")}</p></div><button type="button" onClick={() => manage(account.id)} className="flex flex-none items-center text-xs text-fg-muted hover:text-fg">{account.loggedIn === false ? "登录" : "管理"}<ChevronRight className="size-sm" /></button></div>
        {account.method ? <p className="text-xs text-fg-muted">{account.method} · 使用该渠道计费，不显示订阅额度</p> : account.loggedIn && <>
          {account.usage?.status === "ready" ? <div className="space-y-md">{(expanded ? account.usage.windows : account.usage.windows.slice(0, 2)).map(w => <Quota key={w.id} window={w} />)}{account.usage.balance && <p className="text-xs text-fg-muted">{account.usage.balance}</p>}</div> : <p className="text-xs text-fg-muted">{account.usage?.message ?? (loading ? "正在读取额度…" : "尚未读取额度")}</p>}
          <p className="text-2xs text-fg-faint">{account.id === "github" ? "同一账号用于远程访问和 Copilot 模型" : `可用于 ${account.engines.join("、")} 引擎`}{account.usage?.fetchedAt && <span title={new Date(account.usage.fetchedAt).toLocaleString()}> · {new Date(account.usage.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 更新</span>}</p>
        </>}
      </section>)}
    </div>
    {snapshot?.accounts.some(a => (a.usage?.windows.length ?? 0) > 2) && <button type="button" className="border-t border-border px-md py-sm text-left text-xs text-fg-muted hover:bg-bg-hover" onClick={() => setExpanded(!expanded)}>{expanded ? "收起额外额度" : "更多额度"}</button>}
    {client.remoteSession && <p className="px-md py-sm text-2xs text-fg-faint">此处为远程主机的账号</p>}
  </div>;
}
export function AccountMenu({ client, connected, onManage }: { client: ApiClient; connected: boolean; onManage: (id: AccountSummary["id"]) => void }) {
  const { snapshot } = useAccounts(client);
  const github = snapshot?.accounts.find(a => a.id === "github");
  return <Popover side="top" popupRole="dialog" ariaLabel="账号与用量" className="w-figure max-w-[calc(100vw-var(--spacing-lg))] p-0" trigger={props => <button {...props} type="button" aria-label="账号与用量" className="flex min-w-0 flex-1 items-center gap-sm rounded-md py-2xs text-left hover:bg-bg-hover">
    <span className="flex flex-none -space-x-lg"><AccountIcon account={github ?? { id: "github" }} /><AccountIcon account={{ id: "codex" }} /><AccountIcon account={{ id: "claude" }} /></span>
    <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-body text-fg">{github?.username ?? "账号与用量"}</span><span title={BUILD_DETAIL} className={cn("truncate text-2xs", connected ? "text-fg-faint" : "text-danger")}>{connected ? BUILD_LABEL : "连接断开"}</span></span>
  </button>}>{close => <AccountPanel client={client} manage={id => { close(); onManage(id); }} />}</Popover>;
}
