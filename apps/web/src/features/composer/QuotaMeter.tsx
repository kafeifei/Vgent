import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { AccountLogo, Quota } from "@/features/accounts/AccountMenu";
import { meteredWindows } from "@/features/accounts/accountOf";
import type { AccountSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The subscription quota this task draws on, next to the context ring and in
 * its own card: context is how full *this task* is, quota is how much of the
 * *account* is left, and a task that runs out of either stops for a different
 * reason. The trigger is the account's mark and its fullest window; the card
 * lists every window that can run out, with when it resets.
 *
 * Nothing renders for an account billed by key (`method`), one not signed in,
 * or one whose usage could not be read: there is no quota to speak of.
 */
export function QuotaMeter({ account }: { account: AccountSummary }) {
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
          aria-label={`${account.name}${fullest.label}额度已用 ${Math.round(used)}%`}
          className={cn(
            "h-xl gap-2xs px-2xs font-normal has-[>svg]:px-2xs",
            used >= 90 ? "text-danger hover:text-danger" : used >= 80 ? "text-warning hover:text-warning" : "text-fg-muted hover:text-fg",
          )}
        >
          <span className="font-medium text-muted-foreground">{Math.round(used)}%</span>
          <AccountLogo id={account.id} className="size-md" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-64 divide-y divide-border overflow-hidden border-0 bg-bg-elevated p-0 shadow-popover">
        <div className="flex items-center gap-xs p-3 text-xs">
          <AccountLogo id={account.id} className="size-md text-fg" />
          <span className="text-fg">{account.name}</span>
          {account.plan != null && <span className="rounded-sm bg-bg-inset px-2xs text-2xs text-fg-muted">{account.plan}</span>}
        </div>
        <div className="space-y-md p-3">
          {windows.map((window) => (
            <Quota key={window.id} window={window} />
          ))}
        </div>
        {account.usage.balance != null && <p className="bg-bg-inset p-3 text-xs text-fg-muted">{account.usage.balance}</p>}
      </HoverCardContent>
    </HoverCard>
  );
}
