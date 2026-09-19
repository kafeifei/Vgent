import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { hasTrafficLights } from "@/lib/host";
import { cn } from "@/lib/utils";

export const STRIP_ICON_BUTTON =
  "grid size-xl flex-none place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg aria-pressed:text-fg";

/**
 * The centre column's top strip. There is no window bar above the columns, so
 * this is the title bar: it drags the window, and once the sidebar is folded
 * away it is also where the traffic lights land and where 展开侧栏 lives.
 */
export function TopStrip({
  leftOpen,
  onToggleLeft,
  end,
  children,
}: {
  leftOpen: boolean;
  onToggleLeft: () => void;
  /** Right-aligned controls. */
  end?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-topbar flex-none select-none items-center gap-2xs pr-sm",
        leftOpen ? "pl-[calc(var(--spacing-md)-var(--spacing-2xs))]" : hasTrafficLights() ? "pl-traffic" : "pl-sm",
      )}
    >
      {!leftOpen && (
        <button type="button" title="展开侧栏 ⌘B" aria-label="展开侧栏" onClick={onToggleLeft} className={STRIP_ICON_BUTTON}>
          <PanelLeft className="size-lg" />
        </button>
      )}
      {children}
      {end != null && <div className="ml-auto flex flex-none items-center gap-2xs">{end}</div>}
    </div>
  );
}
