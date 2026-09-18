import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { isImeKeyEvent } from "@/lib/ime";

type TriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
};

/**
 * The one popover in the app: pills, the project switcher, the model picker and
 * the empty-state pickers all use it. Anchored to its trigger with fixed
 * positioning, closed by outside click or Escape.
 */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
  openRef,
}: {
  trigger: (props: TriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
  className?: string;
  /** Filled with an `open()` the owner can call — a row's right-click uses it. */
  openRef?: RefObject<(() => void) | null>;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (openRef == null) return;
    openRef.current = () => setOpen(true);
    return () => {
      openRef.current = null;
    };
  }, [openRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (anchor == null) return;
    const width = panel?.width ?? 0;
    const height = panel?.height ?? 0;
    const left = align === "end" ? anchor.right - width : anchor.left;
    const top = side === "top" ? anchor.top - height - 4 : anchor.bottom + 4;
    setPosition({
      left: Math.max(4, Math.min(left, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(top, window.innerHeight - height - 4)),
    });
  }, [open, align, side]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeKeyEvent(event)) {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((value) => !value),
        "aria-expanded": open,
        "aria-haspopup": "menu",
      })}
      {open && (
        <div
          ref={panelRef}
          role="menu"
          style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
          className={cn(
            "fixed z-40 min-w-[calc(var(--spacing-3xl)*3.4)] max-w-[calc(var(--spacing-3xl)*6)] rounded-md bg-bg-elevated p-2xs shadow-popover",
            className,
          )}
        >
          {children(close)}
        </div>
      )}
    </>
  );
}

/** One row inside a popover. */
export function PopItem({
  children,
  onClick,
  selected = false,
  disabled = false,
  hint,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  disabled?: boolean;
  /** A short suffix shown in the row, e.g. why it is disabled. */
  hint?: string;
  /** The long version of that reason, on hover. */
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      {...(title != null ? { title } : {})}
      onClick={onClick}
      className="flex w-full items-center gap-xs rounded-sm px-xs py-2xs text-left text-fg-muted text-sm hover:bg-bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint != null && <span className="flex-none font-mono text-fg-faint text-xs">{hint}</span>}
      {selected && <span className="flex-none text-brand">✓</span>}
    </button>
  );
}

/** A small uppercase caption above a group of `PopItem`s. */
export function PopTitle({ children }: { children: ReactNode }) {
  return <div className="px-xs py-2xs text-2xs text-fg-faint tracking-widest">{children}</div>;
}
