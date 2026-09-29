import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { BUTTON_GHOST, BUTTON_PRIMARY, Dialog } from "@/features/settings/layout";
import type { ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { AccountKind, AccountLoginAttempt } from "@/lib/types";
import { AccountLogo } from "./AccountLogo";
import { ACCOUNT_NAMES } from "./accountOf";

/** What a caller asks for: a new account (of a platform, or chosen in the dialog), or one signed in to again. */
export interface LoginRequest {
  kind?: AccountKind;
  accountId?: string;
  onDone?: (accountId: string) => void;
}

const AccountLoginContext = createContext<(request?: LoginRequest) => void>(() => {});

/**
 * 登录, from wherever an account is missing: the account page, the provider
 * page, remote access, the model picker, a task that stopped for want of one.
 * All of them open this one dialog in place rather than sending the user to
 * settings.
 */
export const useAccountLogin = () => useContext(AccountLoginContext);

export function AccountLoginProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  const toast = useToast();
  const [request, setRequest] = useState<LoginRequest | null>(null);
  const open = useCallback((next: LoginRequest = {}) => {
    // The host's accounts are signed in to on the host.
    if (client.remoteSession) { toast("请在主机上登录账号"); return; }
    setRequest(next);
  }, [client, toast]);
  return (
    <AccountLoginContext.Provider value={open}>
      {children}
      {request != null && <AccountLoginDialog client={client} request={request} onClose={() => setRequest(null)} />}
    </AccountLoginContext.Provider>
  );
}

const KINDS: readonly AccountKind[] = ["claude", "codex", "github"];

function AccountLoginDialog({ client, request, onClose }: { client: ApiClient; request: LoginRequest; onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<AccountKind | undefined>(request.kind);
  const [attempt, setAttempt] = useState<AccountLoginAttempt>({ state: "idle" });
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const running = useRef(false);
  const done = useRef(request.onDone);
  done.current = request.onDone;

  useEffect(() => {
    if (kind == null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    running.current = true;
    setAttempt({ kind, state: "running" });
    const settle = (next: AccountLoginAttempt) => {
      setAttempt(next);
      if (next.state === "running") { timer = setTimeout(() => void poll(), 1000); return; }
      running.current = false;
      if (next.state === "succeeded" && next.accountId != null) {
        toast(`已添加 ${ACCOUNT_NAMES[kind]} 账号`);
        done.current?.(next.accountId);
        onClose();
      } else if (next.state === "idle") {
        setAttempt({ kind, state: "failed", error: "登录已取消，请重试。" });
      }
    };
    const poll = async () => {
      try {
        const next = await client.getAccountLogin();
        if (!disposed) settle(next);
      } catch (error) {
        if (!disposed) settle({ kind, state: "failed", error: error instanceof Error ? error.message : "登录失败，请重试。" });
      }
    };
    void client.startAccountLogin(kind, request.accountId).then(
      (next) => { if (!disposed) settle(next); },
      (error: unknown) => { if (!disposed) settle({ kind, state: "failed", error: error instanceof Error ? error.message : "无法开始登录，请重试。" }); },
    );
    return () => { disposed = true; clearTimeout(timer); };
    // `request.accountId` is fixed for the dialog's life.
  }, [client, kind, retry]);

  const close = () => {
    if (running.current) void client.cancelAccountLogin().catch(() => undefined);
    onClose();
  };
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => undefined);
  };
  const title = kind == null ? "添加账号" : request.accountId != null ? `重新登录 ${ACCOUNT_NAMES[kind]}` : `添加 ${ACCOUNT_NAMES[kind]} 账号`;

  return (
    <Dialog title={title} onClose={close}>
      <div className="flex flex-col gap-md px-lg py-md">
        {kind == null ? (
          <div className="flex flex-col gap-3xs">
            {KINDS.map((option) => (
              <button key={option} type="button" onClick={() => setKind(option)} className="flex h-row items-center gap-sm rounded-md px-sm text-left text-fg text-md hover:bg-bg-hover">
                <AccountLogo kind={option} className="size-lg text-fg-muted" />
                {ACCOUNT_NAMES[option]}
              </button>
            ))}
          </div>
        ) : kind === "github" ? (
          <>
            <p className="text-fg-muted text-md">复制验证码，在 GitHub 的设备登录页面完成授权。</p>
            {attempt.userCode == null && attempt.state === "running" && <p className="text-fg-faint text-sm">正在向 GitHub 申请验证码…</p>}
            {attempt.userCode != null && attempt.state === "running" && (
              <div className="flex items-center gap-xs rounded-md border border-border bg-bg-inset px-sm py-xs">
                <code className="min-w-0 flex-1 truncate font-mono text-fg text-md select-text">{attempt.userCode}</code>
                <button type="button" onClick={() => copy(attempt.userCode!)} className={BUTTON_GHOST}>
                  {copied ? <Check className="size-md" /> : <Copy className="size-md" />}
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-fg-muted text-md">在浏览器里完成登录，完成后这里会自动更新。</p>
            {attempt.url != null && attempt.state === "running" && (
              <a href={attempt.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-xs text-brand text-md hover:underline">
                打开登录页面
                <ExternalLink className="size-md" />
              </a>
            )}
          </>
        )}
        {attempt.state === "failed" && attempt.error != null && <p role="alert" className="text-danger text-sm">{attempt.error}</p>}
        <div className="flex justify-end gap-xs">
          <button type="button" onClick={close} className={BUTTON_GHOST}>取消</button>
          {attempt.state === "failed" && (
            <button type="button" onClick={() => { setCopied(false); setRetry((value) => value + 1); }} className={BUTTON_PRIMARY}>重新登录</button>
          )}
          {kind === "github" && attempt.state === "running" && attempt.verificationUri != null && (
            <a href={attempt.verificationUri} target="_blank" rel="noreferrer" className={BUTTON_PRIMARY}>
              前往授权
              <ExternalLink className="size-md" />
            </a>
          )}
        </div>
      </div>
    </Dialog>
  );
}
