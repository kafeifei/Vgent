import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { CascadeLevel } from "@/components/CascadeMenu";
import { Popover } from "@/components/Popover";
import { useAccountLogin } from "@/features/accounts/AccountLogin";
import { AccountLogo } from "@/features/accounts/AccountLogo";
import { Quota } from "@/features/accounts/AccountMenu";
import { ACCOUNT_NAMES, whoIs } from "@/features/accounts/accountOf";
import { useAccounts } from "@/features/accounts/useAccounts";
import type { ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { AccountKind, AccountSummary, AccountUse } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BUTTON_GHOST, BUTTON_SECONDARY, Dialog, SettingsEmpty, SettingsGroup, SettingsPage, SettingsRow, Switch, Tag } from "./layout";

/** What each use is called on an account's page. */
const USE_LABELS: Record<AccountUse, string> = {
  models: "模型",
  remote: "远程访问",
};

const KINDS: readonly AccountKind[] = ["claude", "codex", "github"];

/** The account's face: GitHub's avatar, else the platform's mark. */
function AccountAvatar({ account, large = false }: { account: AccountSummary; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("grid flex-none place-items-center overflow-hidden rounded-full border border-border bg-bg-elevated text-fg-muted", large ? "size-2xl" : "size-xl")}>
      {account.avatarUrl != null && !failed
        ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
        : <AccountLogo kind={account.kind} className={large ? "size-lg" : "size-md"} />}
    </span>
  );
}

/**
 * 账号: every login Vgent can use — Claude, Codex, GitHub, as many of each as
 * the user adds — in one list, like the system's Internet Accounts. Opening one
 * shows what it is switched on for, its quota, and signing out.
 */
export function AccountsPage({ client, focus, onFocus }: {
  client: ApiClient;
  /** The account whose page is open; absent is the list. */
  focus: string | undefined;
  onFocus: (id: string | undefined) => void;
}) {
  const { snapshot, error } = useAccounts(client, true);
  const login = useAccountLogin();
  const readOnly = client.remoteSession;
  const account = focus == null ? undefined : snapshot?.accounts.find((entry) => entry.id === focus);

  // An account that signed out elsewhere closes its page.
  useEffect(() => {
    if (focus != null && snapshot != null && account == null) onFocus(undefined);
  }, [focus, snapshot, account, onFocus]);

  if (account != null) return <AccountDetail client={client} account={account} readOnly={readOnly} onBack={() => onFocus(undefined)} />;

  return (
    <SettingsPage
      title="账号"
      actions={!readOnly && (
        <Popover
          align="end"
          ariaLabel="添加账号"
          trigger={(props) => (
            <button {...props} type="button" className={BUTTON_SECONDARY}>
              <Plus className="size-md" />
              添加
            </button>
          )}
        >
          {(close) => (
            <CascadeLevel
              nodes={KINDS.map((kind) => ({
                key: kind,
                label: ACCOUNT_NAMES[kind],
                icon: <AccountLogo kind={kind} />,
                onPick: () => { close(); login({ kind, onDone: onFocus }); },
              }))}
            />
          )}
        </Popover>
      )}
    >
      <SettingsGroup>
        {snapshot == null && <SettingsEmpty>{error ?? "正在读取账号…"}</SettingsEmpty>}
        {snapshot?.accounts.length === 0 && <SettingsEmpty>还没有账号。</SettingsEmpty>}
        {snapshot?.accounts.map((entry) => (
          <div
            key={entry.id}
            role="button"
            tabIndex={0}
            aria-label={`${entry.name}${whoIs(entry) != null ? ` · ${whoIs(entry)}` : ""}`}
            onClick={() => onFocus(entry.id)}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onFocus(entry.id); } }}
            className="cursor-default hover:bg-bg-hover focus-visible:outline focus-visible:outline-brand"
          >
            <SettingsRow
              leading={<AccountAvatar account={entry} />}
              title={<><span className="truncate">{entry.name}</span>{entry.plan != null && <Tag>{entry.plan}</Tag>}</>}
              help={entry.loggedIn === false || entry.usage?.status === "reauth"
                ? <span className="text-warning">{whoIs(entry) ?? ""}{whoIs(entry) != null ? " · " : ""}需要重新登录</span>
                : whoIs(entry) ?? entry.method}
            >
              <ChevronRight className="size-md text-fg-faint" />
            </SettingsRow>
          </div>
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}

function AccountDetail({ client, account, readOnly, onBack }: { client: ApiClient; account: AccountSummary; readOnly: boolean; onBack: () => void }) {
  const toast = useToast();
  const login = useAccountLogin();
  const [pending, setPending] = useState<AccountUse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const who = whoIs(account);
  const needsLogin = account.loggedIn === false || account.usage?.status === "reauth";

  const setUse = (use: AccountUse, enabled: boolean) => {
    setPending(use);
    void client.setAccountUse(account.id, use, enabled)
      .catch((cause: Error) => toast(cause.message))
      .finally(() => setPending(null));
  };

  return (
    <SettingsPage
      title={account.name}
      actions={<button type="button" onClick={onBack} className={cn(BUTTON_GHOST, "order-first -ml-sm")} aria-label="返回账号列表"><ChevronLeft className="size-md" />账号</button>}
    >
      <div className="flex items-center gap-md">
        <AccountAvatar account={account} large />
        <div className="flex min-w-0 flex-col gap-3xs">
          <div className="flex items-center gap-xs text-fg text-md">
            <span className="truncate">{who ?? account.name}</span>
            {account.plan != null && <Tag>{account.plan}</Tag>}
          </div>
          {account.method != null && <span className="text-fg-muted text-sm">{account.method}</span>}
          {needsLogin && <span className="text-sm text-warning">需要重新登录</span>}
        </div>
      </div>

      <SettingsGroup title="用途">
        {account.uses.map((use) => (
          <SettingsRow key={use.id} title={USE_LABELS[use.id]}>
            <Switch checked={use.enabled} label={USE_LABELS[use.id]} disabled={readOnly || pending != null} onChange={(enabled) => setUse(use.id, enabled)} />
          </SettingsRow>
        ))}
      </SettingsGroup>

      {account.loggedIn === true && account.method == null && (
        <SettingsGroup title="额度">
          {account.usage?.status === "ready" && account.usage.windows.length > 0 ? (
            <div className="flex flex-col gap-md px-md py-sm">
              {account.usage.windows.map((window) => <Quota key={window.id} window={window} />)}
              {account.usage.balance != null && <p className="text-fg-muted text-xs">{account.usage.balance}</p>}
              {account.usage.message && <p className="text-warning text-xs">{account.usage.message}</p>}
              <p className="text-fg-faint text-2xs">{new Date(account.usage.fetchedAt).toLocaleString()} 更新{account.usage.retryAt ? ` · 最早 ${new Date(account.usage.retryAt).toLocaleString()} 可补查` : ""}</p>
            </div>
          ) : (
            <SettingsEmpty>{account.usage?.message ?? "尚未读取额度"}</SettingsEmpty>
          )}
        </SettingsGroup>
      )}

      {!readOnly && (
        <div className="flex justify-end gap-xs">
          {needsLogin && <button type="button" className={BUTTON_SECONDARY} onClick={() => login({ kind: account.kind, accountId: account.id })}>重新登录</button>}
          <button type="button" className={cn(BUTTON_GHOST, "hover:bg-danger-bg hover:text-danger")} onClick={() => setConfirming(true)}>退出登录</button>
        </div>
      )}

      {confirming && <SignOutDialog client={client} account={account} onDone={onBack} onClose={() => setConfirming(false)} />}
    </SettingsPage>
  );
}

function SignOutDialog({ client, account, onDone, onClose }: { client: ApiClient; account: AccountSummary; onDone: () => void; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const message = account.machine === true
    ? `这是这台电脑上的 ${account.name} 登录，终端里的 ${account.kind === "claude" ? "claude" : "codex"} 也会一起退出。`
    : account.kind === "github"
      ? "远程访问如果在用这个账号，也会一起关闭。"
      : "用这个账号的任务需要换一个模型才能继续。";
  const confirm = () => {
    setBusy(true);
    setError(undefined);
    void client.logoutAccount(account.id).then(
      () => { toast(`已退出 ${account.name}${whoIs(account) != null ? ` · ${whoIs(account)}` : ""}`); onClose(); onDone(); },
      (cause: Error) => { setError(cause.message); setBusy(false); },
    );
  };
  return (
    <Dialog title={`退出 ${account.name}`} onClose={() => { if (!busy) onClose(); }}>
      <div className="flex flex-col gap-md px-lg py-md">
        <p className="text-fg-muted text-md">{message}</p>
        {error != null && <p className="text-danger text-sm">{error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" disabled={busy} onClick={onClose} className={BUTTON_GHOST}>取消</button>
          <button type="button" disabled={busy} onClick={confirm} className={cn(BUTTON_GHOST, "text-danger hover:bg-danger-bg hover:text-danger")}>{busy ? "处理中…" : "退出登录"}</button>
        </div>
      </div>
    </Dialog>
  );
}
