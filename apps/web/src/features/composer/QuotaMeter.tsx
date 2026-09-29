import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useAccountLogin } from "@/features/accounts/AccountLogin";
import { AccountLogo, Quota } from "@/features/accounts/AccountMenu";
import { meteredWindows, whoIs } from "@/features/accounts/accountOf";
import type { AccountSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The same model on another account of the same engine: what 换号 moves the task to. */
export interface QuotaSwitch {
  id: string;
  label: string;
  onSwitch: () => void;
}

/**
 * The subscription quota this task draws on, next to the context ring and in
 * its own card: context is how full *this task* is, quota is how much of the
 * *account* is left, and a task that runs out of either stops for a different
 * reason. The trigger is the account's mark and its fullest window; the card
 * lists every window that can run out, with when it resets, and — when the
 * same model runs on another account — moves the task there.
 *
 * An account that has to sign in again says so, and signs in right here.
 * Nothing renders for an account billed by key (`method`) or one whose usage
 * could not be read: there is no quota to speak of.
 */
export function QuotaMeter({ account, switches = [] }: { account: AccountSummary; switches?: readonly QuotaSwitch[] }) {
  const login = useAccountLogin();
  const who = whoIs(account);
  const name = who != null ? `${account.name} · ${who}` : account.name;

  if (account.loggedIn === false || account.usage?.status === "reauth") {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => login(account.uses.length > 0 ? { kind: account.kind, accountId: account.id } : { kind: account.kind })}
        className="h-xl gap-2xs px-2xs font-normal text-warning hover:text-warning has-[>svg]:px-2xs"
      >
        <AccountLogo kind={account.kind} className="size-md" />
        {account.uses.length > 0 ? "需要重新登录" : `登录 ${account.name}`}
      </Button>
    );
  }
  if (account.loggedIn !== true || account.method != null || account.usage?.status !== "ready") return null;
  const windows = meteredWindows(account.usage.windows);
  const fullest = windows[0];
  if (fullest?.usedPercent == null) return null;
  const used = fullest.usedPercent;

  return (
    <HoverCard openDelay={0} closeDelay={0}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${name}${fullest.label}额度已用 ${Math.round(used)}%`}
          className={cn(
            "h-xl gap-2xs px-2xs font-normal has-[>svg]:px-2xs",
            used >= 90 ? "text-danger hover:text-danger" : used >= 80 ? "text-warning hover:text-warning" : "text-fg-muted hover:text-fg",
          )}
        >
          <span className="font-medium text-muted-foreground">{Math.round(used)}%</span>
          <AccountLogo kind={account.kind} className="size-md" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-64 divide-y divide-border overflow-hidden border-0 bg-bg-elevated p-0 shadow-popover">
        <div className="flex min-w-0 items-center gap-xs p-3 text-xs">
          <AccountLogo kind={account.kind} className="size-md text-fg" />
          <span className="min-w-0 truncate text-fg" title={name}>{name}</span>
          {account.plan != null && <span className="flex-none rounded-sm bg-bg-inset px-2xs text-2xs text-fg-muted">{account.plan}</span>}
        </div>
        <div className="space-y-md p-3">
          {windows.map((window) => (
            <Quota key={window.id} window={window} />
          ))}
        </div>
        {account.usage.balance != null && <p className="bg-bg-inset p-3 text-xs text-fg-muted">{account.usage.balance}</p>}
        {switches.length > 0 && (
          <div className="flex flex-col p-1">
            {switches.map((option) => (
              <button key={option.id} type="button" onClick={option.onSwitch} className="truncate rounded-sm px-2 py-1.5 text-left text-xs text-fg-muted hover:bg-bg-hover hover:text-fg" title={option.label}>
                换到 {option.label} 继续
              </button>
            ))}
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
