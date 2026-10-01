import { isImeKeyEvent } from "@/lib/ime";

/**
 * The keyboard half of the two hand-written menus, `Popover` and
 * `CascadeLevel`, after the WAI-ARIA menu pattern: ↑ ↓ Home End move between
 * rows and wrap, → opens a submenu, ← and Esc close it, Tab leaves the menu.
 * Enter and Space are the focused button's own. The decisions are plain
 * functions so they run without a DOM; the few DOM calls stay in
 * `handleMenuKeyDown` and the two helpers under it, and only call methods —
 * nothing here needs `Element` or `document` to exist.
 */

/** What a key press means to a menu. */
export type MenuIntent = "next" | "previous" | "first" | "last" | "into" | "out" | "close" | "leave";

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean };
/** A DOM `KeyboardEvent` or a React synthetic one. */
export type MenuKeyEvent = KeyLike & Parameters<typeof isImeKeyEvent>[0];

/**
 * The intent of a key, or null when it is not a menu's: a chord belongs to the
 * app (⌘K, ⌘N…), and an input method's keys are not ours (`lib/ime`).
 */
export function menuIntent(event: MenuKeyEvent): MenuIntent | null {
  if (event.metaKey || event.ctrlKey || event.altKey || isImeKeyEvent(event)) return null;
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "ArrowRight":
      return "into";
    case "ArrowLeft":
      return "out";
    case "Escape":
      return "close";
    case "Tab":
      return "leave";
    default:
      return null;
  }
}

/** The row focus lands on, from `current` (-1: no row has it) among `count` rows. Wraps at both ends. */
export function moveIndex(move: "next" | "previous" | "first" | "last", current: number, count: number): number {
  if (count <= 0) return -1;
  switch (move) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
      return current < 0 ? 0 : (current + 1) % count;
    case "previous":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
  }
}

export type MenuAction =
  | { type: "focus"; index: number }
  | { type: "close-submenu" }
  | { type: "close-menu" }
  | { type: "none" };

/**
 * What one level of a menu does with an intent. → is not decided here: the row
 * that has a submenu owns it (`CascadeLevel`). Esc closes only the innermost
 * level, so a submenu goes back to its row before the whole menu goes.
 */
export function decideMenuKey(intent: MenuIntent, level: { current: number; count: number; nested: boolean }): MenuAction {
  switch (intent) {
    case "next":
    case "previous":
    case "first":
    case "last": {
      const index = moveIndex(intent, level.current, level.count);
      return index < 0 ? { type: "none" } : { type: "focus", index };
    }
    case "out":
      return level.nested ? { type: "close-submenu" } : { type: "none" };
    case "close":
      return level.nested ? { type: "close-submenu" } : { type: "close-menu" };
    case "leave":
      return { type: "close-menu" };
    case "into":
      return { type: "none" };
  }
}

export const MENU_ROW = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
export const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const MENU = '[role="menu"]';
/** `Node.DOCUMENT_POSITION_FOLLOWING`: the node compared against comes after this one. */
const DOCUMENT_POSITION_FOLLOWING = 4;
const TABBABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The rows of `menu` itself that can take focus: enabled, and not a row of a submenu opened inside it. */
export function menuRows(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ROW)).filter(
    (row) => row.closest(MENU) === menu && !row.hasAttribute("disabled") && row.getAttribute("aria-disabled") !== "true",
  );
}

/** Where focus enters a level's rows from outside them: the row that is the current choice (`data-selected`), else the first. */
export function entryRow<T extends { hasAttribute(name: string): boolean }>(rows: readonly T[]): T | undefined {
  return rows.find((row) => row.hasAttribute("data-selected")) ?? rows[0];
}

/** What a panel that is not a menu (a dialog-role popover) offers focus: its controls, in order. */
export function tabbablesOf(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE));
}

/** Focus a row, and bring it into view when a scrolling list has it below the fold. */
export function focusRow(row: HTMLElement, reveal = true): void {
  row.focus({ preventScroll: true });
  if (reveal) row.scrollIntoView?.({ block: "nearest" });
}

/**
 * An Enter that is still held down. The menu opens on Enter and focus moves onto
 * its first row within that very press, so a key held past the auto-repeat
 * delay would click that row: a row ignores it.
 */
export function isHeldEnter(event: { key: string; repeat: boolean }): boolean {
  return event.key === "Enter" && event.repeat;
}

/** Where focus goes when a menu opens: its first row for a keyboard, its last for ↑, else the panel itself so nothing lights up under a pointer. */
export type InitialFocus = "panel" | "first" | "last";

export function initialFocusTarget<T>(want: InitialFocus, rows: readonly T[], panel: T): T {
  if (want === "first") return rows[0] ?? panel;
  if (want === "last") return rows.at(-1) ?? panel;
  return panel;
}

/**
 * The row an arrow key enters a menu on from outside it — the trigger, or a
 * page that has focus because the row that had it went away: ↓ the first row,
 * ↑ the last. Enter and Space already click the trigger, and arrive with
 * `detail` 0 — see `Popover`.
 */
export function arrowEntry(event: MenuKeyEvent): "first" | "last" | null {
  const intent = menuIntent(event);
  return intent === "next" ? "first" : intent === "previous" ? "last" : null;
}

/**
 * After a popover closed: does focus go back to its trigger? Only when nobody
 * else has claimed it — the row that closed the menu is gone and focus fell to
 * the page, or it was the trigger's already. A pointer that went off to click
 * something else, or a row that opened a field of its own, keeps its focus.
 */
export function shouldRestoreFocus({
  wanted,
  active,
  body,
  trigger,
}: {
  wanted: boolean;
  active: unknown;
  body: unknown;
  trigger: unknown;
}): boolean {
  return wanted && (active == null || active === body || active === trigger);
}

/** Whether a key press is landing on the page, not on anything: the row that had focus went away. */
export function focusIsLost(target: unknown, body: unknown): boolean {
  return target == null || target === body;
}

/** Whether `target` sits in a submenu opened inside `panel` rather than in the panel's own level. */
export function inSubmenu(target: EventTarget | null, panel: HTMLElement): boolean {
  const owner = (target as HTMLElement | null)?.closest?.(MENU) ?? null;
  return owner != null && owner !== panel && panel.contains(owner);
}

export interface MenuLevel {
  /** This level is a submenu: ← and Esc close it, and focus goes back to the row that opened it. */
  nested: boolean;
  closeSubmenu?: () => void;
  /** Tab: close the whole menu. Left out on a submenu — the level above has it. */
  closeMenu?: () => void;
}

/**
 * One level's answer to a key press that reached it; true when it took the key
 * (and, with it, stopped the event, so the level above does not answer too).
 * `menu` is the element with `role="menu"` that owns the rows.
 *
 *  - A text box inside the menu keeps its own arrows, Home / End and Tab; ↓
 *    leaves it for the rows under it — the current choice, if the list has
 *    one — which is how a search box hands over, and ↑ from the first row goes
 *    back up to it, instead of wrapping past it.
 *  - A key that came out of a submenu is that submenu's, except Tab.
 *  - Tab only means "leave" on a row; on a field inside the panel it is Tab.
 */
export function handleMenuKeyDown(
  event: MenuKeyEvent & { target: EventTarget | null; preventDefault(): void; stopPropagation(): void },
  menu: HTMLElement,
  level: MenuLevel,
): boolean {
  const intent = menuIntent(event);
  if (intent == null) return false;
  const target = event.target as HTMLElement | null;
  if ((target?.closest?.(MENU) ?? null) !== menu && intent !== "leave") return false;

  const rows = menuRows(menu);
  const row = target?.closest?.(MENU_ROW) ?? null;
  const editable = target?.closest?.(EDITABLE) != null;

  if (!editable && intent === "previous" && row != null && row === rows[0]) {
    const field = menu.querySelector<HTMLElement>(EDITABLE);
    if (field != null && field.closest(MENU) === menu && (field.compareDocumentPosition(row) & DOCUMENT_POSITION_FOLLOWING) !== 0) {
      field.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  }

  let action: MenuAction;
  if (editable) {
    if (intent === "next") {
      const entry = entryRow(rows);
      if (entry == null) return false;
      focusRow(entry);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    action = intent === "close" && level.nested ? { type: "close-submenu" } : { type: "none" };
  } else if (intent === "leave" && row == null) {
    action = { type: "none" };
  } else {
    action = decideMenuKey(intent, { current: row == null ? -1 : rows.indexOf(row as HTMLElement), count: rows.length, nested: level.nested });
  }

  if (action.type === "focus") {
    const next = rows[action.index];
    if (next == null) return false;
    focusRow(next);
  } else if (action.type === "close-submenu") {
    if (level.closeSubmenu == null) return false;
    level.closeSubmenu();
  } else if (action.type === "close-menu") {
    if (level.closeMenu == null) return false;
    level.closeMenu();
  } else {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}
