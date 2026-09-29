import type { AccountSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The platform's mark, painted in the text colour. */
export function AccountLogo({ kind, className }: { kind: AccountSummary["kind"]; className?: string }) {
  const mask = `url(/account-logos/${kind}.svg) center / contain no-repeat`;
  return <span aria-hidden className={cn("flex-none bg-current", className ?? "size-md")} style={{ mask, WebkitMask: mask }} />;
}
