import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { isImeKeyEvent } from "@/lib/ime";
import {
  EDITABLE,
  MENU_ROW,
  arrowEntry,
  focusIsLost,
  focusRow,
  handleMenuKeyDown,
  inSubmenu,
  initialFocusTarget,
  isHeldEnter,
  menuRows,
  shouldRestoreFocus,
  tabbablesOf,
  type InitialFocus,
} from "./menuKeys";

type TriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  /** Enter and Space click the button with `detail` 0: the keyboard opens the menu on its first row. */
  onClick: (event: { detail: number }) => void;
  /** ↓ / ↑ on a menu's trigger open it on its first / last row. */
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu" | "dialog";
};

type ShortcutEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "repeat" | "isComposing" | "keyCode">;

/**
 * The key a menu shortcut is matched on, or null when the press is not one:
 * a chord belongs to the app (⌘N, ⌘K…), a held key must not fire twice, and an
 * input method's keys are not ours.
 */
export function shortcutKey(event: ShortcutEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || isImeKeyEvent(event)) return null;
  return event.key.toLowerCase();
}

/** What the popover's own key listener does with a press while it is open. */
export type PanelKey =
  | { type: "none" }
  | { type: "close" }
  /** Focus fell to the page; an arrow puts it back on this row. */
  | { type: "enter"; row: HTMLElement }
  /** A `PopItem` answers to this key, wherever focus is. */
  | { type: "shortcut"; key: string };

/**
 * The popover listens on the document, not on its panel, because Escape and a
 * row's shortcut have to work whatever has focus. This is that listener's
 * decision, apart from the event:
 *
 *  - Esc closes it — unless it came out of a submenu, which closes first and
 *    hears the same key itself.
 *  - Focus that fell to the page — the row that had it went away, or was
 *    disabled under it — is put back on a row by ↓ / ↑.
 *  - A `shortcut` row answers to its key. A text box inside the panel keeps its
 *    own typing, and a row that has focus takes Enter itself, whichever row
 *    carries the ↵ shortcut.
 */
export function panelKey(
  event: ShortcutEvent & { target: EventTarget | null },
  panel: HTMLElement | null,
  options: { menu: boolean; body: unknown },
): PanelKey {
  if (event.key === "Escape" && !isImeKeyEvent(event)) {
    return panel != null && inSubmenu(event.target, panel) ? { type: "none" } : { type: "close" };
  }
  if (panel == null) return { type: "none" };
  if (options.menu && focusIsLost(event.target, options.body)) {
    const entry = arrowEntry(event);
    const rows = entry == null ? [] : menuRows(panel);
    const row = entry === "last" ? rows.at(-1) : rows[0];
    if (row != null) return { type: "enter", row };
  }
  const key = shortcutKey(event);
  if (key == null) return { type: "none" };
  const target = event.target as Element | null;
  if (target?.closest != null && panel.contains(target)) {
    if (target.closest(EDITABLE) != null) return { type: "none" };
    if (key === "enter" && target.closest(MENU_ROW) != null) return { type: "none" };
  }
  return { type: "shortcut", key };
}

/**
 * The one popover in the app: pills, the project switcher, the model picker and
 * the empty-state pickers all use it. Anchored to its trigger with fixed
 * positioning, closed by outside click or Escape.
 *
 * It is keyboard-operable as a WAI-ARIA menu (`menuKeys.ts`): focus moves in
 * when it opens — onto the first row for Enter / Space / ↓ on the trigger, the
 * last for ↑, the panel itself for a pointer, so nothing lights up under a
 * mouse — ↑ ↓ Home End walk the rows, Tab and Esc close it, and once a keyboard
 * has used it, focus goes back to the trigger unless something else has taken it.
 */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  className,
  openRef,
  popupRole = "menu",
  ariaLabel,
}: {
  trigger: (props: TriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  popupRole?: "menu" | "dialog";
  ariaLabel?: string;
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
  // Where focus lands when the panel opens, and whether closing gives it back to
  // the trigger: only after a keyboard used the menu (a mouse never had focus to
  // give back), and not when the pointer went off to click something else.
  const initialFocus = useRef<InitialFocus>("panel");
  const restoreFocus = useRef(true);
  const keyboardDriven = useRef(false);
  const wasOpen = useRef(false);

  const close = useCallback(() => setOpen(false), []);
  const openWith = useCallback((focus: InitialFocus) => {
    initialFocus.current = focus;
    restoreFocus.current = true;
    keyboardDriven.current = focus !== "panel";
    setOpen(true);
  }, []);

  useEffect(() => {
    if (openRef == null) return;
    openRef.current = () => openWith("panel");
    return () => {
      openRef.current = null;
    };
  }, [openRef, openWith]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionPanel = () => {
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
    };
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", positionPanel);
    return () => { observer.disconnect(); window.removeEventListener("resize", positionPanel); };
  }, [open, align, side]);

  // Focus moves into the panel as it opens. It has to be in there for the arrow
  // keys to have anything to act on; a field of the panel's own that already
  // took it (autoFocus) is left alone.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || panel == null || panel.contains(document.activeElement)) return;
    const rows = popupRole === "menu" ? menuRows(panel) : tabbablesOf(panel);
    focusRow(initialFocusTarget(initialFocus.current, rows, panel), false);
  }, [open, popupRole]);

  // Closing hands focus back to the trigger, so a keyboard is not left on a page
  // that has just lost the row it was on. A mouse left focus where it found it.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const trigger = triggerRef.current;
    if (trigger == null || !trigger.isConnected) return;
    if (shouldRestoreFocus({ wanted: restoreFocus.current && keyboardDriven.current, active: document.activeElement, body: document.body, trigger })) {
      trigger.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      // The pointer went to click something else, and focus goes with it.
      restoreFocus.current = false;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      keyboardDriven.current = true;
      const action = panelKey(event, panel, { menu: popupRole === "menu", body: document.body });
      if (action.type === "close") {
        event.stopPropagation();
        setOpen(false);
      } else if (action.type === "enter") {
        event.preventDefault();
        event.stopPropagation();
        focusRow(action.row);
      } else if (action.type === "shortcut") {
        const item = panel?.querySelector<HTMLButtonElement>(`[data-pop-key="${CSS.escape(action.key)}"]:not(:disabled)`);
        if (item == null) return;
        event.preventDefault();
        event.stopPropagation();
        item.click();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, popupRole]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: (event) => (open ? setOpen(false) : openWith(event.detail === 0 ? "first" : "panel")),
        onKeyDown: (event) => {
          const entry = popupRole === "menu" ? arrowEntry(event) : null;
          if (entry == null) return;
          event.preventDefault();
          const panel = panelRef.current;
          // Already open, and focus is on the trigger: ↓ / ↑ step into it.
          const rows = open && panel != null ? menuRows(panel) : null;
          const row = entry === "last" ? rows?.at(-1) : rows?.[0];
          if (row != null) focusRow(row);
          else if (!open) openWith(entry);
        },
        "aria-expanded": open,
        "aria-haspopup": popupRole,
      })}
      {open && (
        <div
          ref={panelRef}
          role={popupRole}
          aria-label={ariaLabel}
          // Focusable by script only: the panel takes focus when a pointer opened it, and Tab never lands on it.
          tabIndex={-1}
          onKeyDown={(event) => {
            const panel = panelRef.current;
            if (popupRole === "menu" && panel != null) handleMenuKeyDown(event, panel, { nested: false, closeMenu: close });
          }}
          onBlur={(event) => {
            // Focus went out of the popover by keyboard (Tab): it is done. Focus that left for another window has no target.
            const next = event.relatedTarget;
            if (next == null || panelRef.current?.contains(next) === true || triggerRef.current?.contains(next) === true) return;
            restoreFocus.current = false;
            setOpen(false);
          }}
          style={{ left: position?.left ?? -9999, top: position?.top ?? -9999 }}
          className={cn(
            "fixed z-40 min-w-[calc(var(--spacing-3xl)*3.4)] max-w-[calc(var(--spacing-3xl)*6)] rounded-md bg-bg-elevated p-2xs shadow-popover outline-hidden",
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
  role = "menuitem",
  checked,
  disabled = false,
  hint,
  title,
  shortcut,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  role?: "menuitem" | "menuitemcheckbox" | "menuitemradio";
  checked?: boolean;
  disabled?: boolean;
  /** The key that picks this row while the menu is open: a letter, or `Enter`. */
  shortcut?: string;
  /** A short suffix shown in the row, e.g. why it is disabled. */
  hint?: string;
  /** The long version of that reason, on hover. */
  title?: string;
}) {
  return (
    // tabIndex -1: the menu is one stop, and ↑ ↓ move between its rows (`menuKeys.ts`) — Tab does not walk them.
    <button
      type="button"
      role={role}
      aria-checked={checked}
      tabIndex={-1}
      disabled={disabled}
      {...(title != null ? { title } : {})}
      {...(shortcut != null ? { "data-pop-key": shortcut.toLowerCase(), "aria-keyshortcuts": shortcut } : {})}
      onKeyDown={(event) => {
        if (isHeldEnter(event)) event.preventDefault();
      }}
      onClick={onClick}
      className="flex w-full items-center gap-xs rounded-sm px-xs py-2xs text-left text-fg-muted text-sm outline-hidden hover:bg-bg-active hover:text-fg focus-visible:bg-bg-active focus-visible:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint != null && <span className="flex-none font-mono text-fg-faint text-xs">{hint}</span>}
      {(selected || checked === true) && <span aria-hidden className="flex-none text-brand">✓</span>}
      {/* A disabled row says why instead: its key does nothing. */}
      {shortcut != null && !disabled && (
        <span aria-hidden className="flex-none pl-md font-mono text-fg-faint text-xs">
          {shortcut === "Enter" ? "↵" : shortcut.toUpperCase()}
        </span>
      )}
    </button>
  );
}

/** A small uppercase caption above a group of `PopItem`s. */
export function PopTitle({ children }: { children: ReactNode }) {
  return <div className="px-xs py-2xs text-2xs text-fg-faint tracking-widest">{children}</div>;
}
