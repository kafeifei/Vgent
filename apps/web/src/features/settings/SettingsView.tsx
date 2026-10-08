import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleUserRound, Download, Globe, Cpu, Plug, Settings2, Wrench } from "lucide-react";
import type { ApiClient } from "@/lib/api";
import { isImeKeyEvent } from "@/lib/ime";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, Settings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AccountsPage } from "./AccountsPage";
import { AllowlistSection } from "./AllowlistSection";
import { AppearanceSection } from "./AppearanceSection";
import { ComputerUseSection } from "./ComputerUseSection";
import { McpSection } from "./McpSection";
import { NotificationsSection } from "./NotificationsSection";
import { ProvidersPage } from "./ProvidersPage";
import { RemotePage } from "./RemotePage";
import { EngineOptionsSection } from "./EngineOptionsSection";
import { RuntimesSection } from "./RuntimesSection";
import { WorktreesSection } from "./WorktreesSection";
import { BUTTON_SECONDARY, SettingsGroup, SettingsPage, SettingsRow } from "./layout";

export type SettingsTab = "general" | "accounts" | "engines" | "providers" | "tools" | "remote" | "downloads";

const TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: typeof Cpu }> = [
  { id: "general", label: "通用", icon: Settings2 },
  { id: "accounts", label: "账号", icon: CircleUserRound },
  { id: "engines", label: "引擎", icon: Cpu },
  { id: "providers", label: "模型与提供商", icon: Plug },
  { id: "tools", label: "工具与扩展", icon: Wrench },
  { id: "downloads", label: "下载与更新", icon: Download },
  { id: "remote", label: "远程访问", icon: Globe },
];

/** Simple preferences save on change; complex forms own their save/cancel flow. */
export function SettingsView({ initialTab = "general", initialAccount, settings, engines, client, onClose, onOpenStyleLab }: {
  initialTab?: SettingsTab;
  /** The account page to open on the 账号 tab. */
  initialAccount?: string | undefined;
  settings: Settings | null;
  engines: EngineDescriptor[];
  client: ApiClient;
  onClose: () => void;
  onOpenStyleLab?: () => void;
}) {
  const toast = useToast();
  const [current, setCurrent] = useState(settings);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [account, setAccount] = useState<string | undefined>(initialAccount);
  /** 管理账号 from anywhere in settings: that account's page. */
  const manageAccount = (id: string) => { setAccount(id); setTab("accounts"); };

  useEffect(() => { setCurrent(settings); }, [settings]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !isImeKeyEvent(event)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Never send the page snapshot: it could undo theme, model or provider edits.
  // Keep each control at its saved value on failure, and prevent duplicate writes.
  // `keys` are the fields the write touches; only those are taken from its answer.
  const write = async (keys: ReadonlyArray<keyof Settings>, request: () => Promise<Settings>): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setSaving(true);
    try {
      const result = await request();
      setCurrent((previous) => {
        if (previous == null) return result;
        const next = { ...previous };
        for (const key of keys) {
          delete next[key];
          Object.assign(next, key in result ? { [key]: result[key] } : {});
        }
        return next;
      });
      return true;
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const save = (patch: Parameters<ApiClient["putSettings"]>[0]): Promise<boolean> =>
    write(Object.keys(patch) as Array<keyof Settings>, () => client.putSettings(patch));

  if (current == null) return <div className="p-md text-fg-faint text-md">加载中…</div>;

  const pages: Record<SettingsTab, ReactNode> = {
    general: (
      <SettingsPage title="通用">
        <AppearanceSection />
        <NotificationsSection enabled={current.systemNotifications !== false} disabled={saving}
          onChange={(value) => { void save({ systemNotifications: value }); }} />
        <WorktreesSection value={current.worktreeMaxCount} saving={saving} onSave={(value) => save({ worktreeMaxCount: value })} />
        <AllowlistSection entries={current.allowlist} saving={saving}
          onRemove={(entry) => { void write(["allowlist"], () => client.disallowTool(entry)); }} />
        {onOpenStyleLab && <details className="group flex flex-col">
          <summary className="cursor-pointer text-fg-muted text-sm">开发者选项</summary>
          <div className="pt-sm"><SettingsGroup>
            <SettingsRow title="聊天样式" help="在真实聊天布局中调试消息、工具和各类任务状态。">
              <button type="button" onClick={onOpenStyleLab} className={BUTTON_SECONDARY}>打开样式页面</button>
            </SettingsRow>
          </SettingsGroup></div>
        </details>}
      </SettingsPage>
    ),
    engines: (
      <SettingsPage title="引擎">
        <EngineOptionsSection engines={engines} settings={current} client={client}
          onSaved={(result) => setCurrent((previous) => {
            if (previous == null) return result;
            const { engineOptions: _, ...rest } = previous;
            return result.engineOptions == null ? rest : { ...rest, engineOptions: result.engineOptions };
          })} />
      </SettingsPage>
    ),
    downloads: (
      <SettingsPage title="下载与更新">
        <RuntimesSection client={client} autoUpgrade={current.autoUpgradeRuntimes !== false} disabled={saving}
          onAutoUpgrade={(value) => { void save({ autoUpgradeRuntimes: value }); }} />
      </SettingsPage>
    ),
    accounts: <AccountsPage client={client} focus={account} onFocus={setAccount} />,
    providers: <ProvidersPage client={client} engines={engines} onManageAccount={manageAccount} />,
    tools: (
      <SettingsPage title="工具与扩展">
        <McpSection client={client} servers={current.mcpServers ?? []}
          onSaved={(servers) => setCurrent((previous) => previous == null ? previous : { ...previous, mcpServers: servers })} />
        <ComputerUseSection client={client} enabled={current.computerUseProvider === "cua"} disabled={saving}
          onEnabledChange={(value) => { void save({ computerUseProvider: value ? "cua" : null }); }} />
      </SettingsPage>
    ),
    remote: <RemotePage client={client} onManageAccount={manageAccount} />,
  };

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="设置" className="flex w-[calc(var(--spacing-3xl)*4)] flex-none flex-col gap-3xs border-border border-r bg-bg-sidebar p-md">
        <h1 className="mb-sm px-sm font-semibold text-fg text-md leading-[var(--spacing-xl)]">设置</h1>
        {TABS.map((entry) => (
          <button key={entry.id} type="button" aria-current={tab === entry.id ? "page" : undefined} onClick={() => { setTab(entry.id); if (entry.id === "accounts") setAccount(undefined); }}
            className={cn("flex h-row items-center gap-sm rounded-md px-sm text-left text-fg-secondary text-sm hover:bg-bg-hover hover:text-fg", tab === entry.id && "bg-bg-active text-fg")}>
            <entry.icon className="size-lg flex-none" />{entry.label}
          </button>
        ))}
      </nav>
      <div key={tab} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-md px-2xl py-xl">{pages[tab]}</div>
      </div>
    </div>
  );
}
