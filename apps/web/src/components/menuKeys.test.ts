import { describe, expect, it, vi } from "vitest";
import {
  EDITABLE,
  MENU_ROW,
  arrowEntry,
  decideMenuKey,
  entryRow,
  focusIsLost,
  focusRow,
  handleMenuKeyDown,
  inSubmenu,
  initialFocusTarget,
  isHeldEnter,
  menuIntent,
  menuRows,
  moveIndex,
  shouldRestoreFocus,
} from "./menuKeys";
import { panelKey } from "./Popover";

const press = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...extra,
});

describe("menuIntent", () => {
  it("maps the WAI-ARIA menu keys", () => {
    expect(menuIntent(press("ArrowDown"))).toBe("next");
    expect(menuIntent(press("ArrowUp"))).toBe("previous");
    expect(menuIntent(press("Home"))).toBe("first");
    expect(menuIntent(press("End"))).toBe("last");
    expect(menuIntent(press("ArrowRight"))).toBe("into");
    expect(menuIntent(press("ArrowLeft"))).toBe("out");
    expect(menuIntent(press("Escape"))).toBe("close");
    expect(menuIntent(press("Tab"))).toBe("leave");
  });

  it("leaves Enter, Space and letters to the row and to shortcuts", () => {
    expect(menuIntent(press("Enter"))).toBeNull();
    expect(menuIntent(press(" "))).toBeNull();
    expect(menuIntent(press("d"))).toBeNull();
  });

  it("leaves chords to the app and input-method keys to the input method", () => {
    expect(menuIntent(press("ArrowDown", { metaKey: true }))).toBeNull();
    expect(menuIntent(press("ArrowDown", { altKey: true }))).toBeNull();
    expect(menuIntent(press("ArrowDown", { ctrlKey: true }))).toBeNull();
    expect(menuIntent(press("ArrowDown", { isComposing: true }))).toBeNull();
    // WebKit's late Enter after a candidate is confirmed carries keyCode 229; so can an arrow.
    expect(menuIntent(press("ArrowDown", { keyCode: 229 }))).toBeNull();
    expect(menuIntent({ ...press("Escape", { isComposing: false }), nativeEvent: { isComposing: true } })).toBeNull();
  });
});

describe("moveIndex", () => {
  it("steps and wraps at both ends", () => {
    expect(moveIndex("next", 0, 3)).toBe(1);
    expect(moveIndex("next", 2, 3)).toBe(0);
    expect(moveIndex("previous", 1, 3)).toBe(0);
    expect(moveIndex("previous", 0, 3)).toBe(2);
  });

  it("jumps with Home and End", () => {
    expect(moveIndex("first", 2, 4)).toBe(0);
    expect(moveIndex("last", 0, 4)).toBe(3);
  });

  it("enters from no row at all: ↓ on the first, ↑ on the last", () => {
    expect(moveIndex("next", -1, 3)).toBe(0);
    expect(moveIndex("previous", -1, 3)).toBe(2);
  });

  it("has nowhere to go without rows", () => {
    expect(moveIndex("next", -1, 0)).toBe(-1);
    expect(moveIndex("last", -1, 0)).toBe(-1);
  });
});

describe("decideMenuKey", () => {
  const root = { current: 1, count: 3, nested: false };
  const sub = { ...root, nested: true };

  it("moves focus", () => {
    expect(decideMenuKey("next", root)).toEqual({ type: "focus", index: 2 });
    expect(decideMenuKey("previous", root)).toEqual({ type: "focus", index: 0 });
    expect(decideMenuKey("last", root)).toEqual({ type: "focus", index: 2 });
    expect(decideMenuKey("next", { ...root, count: 0 })).toEqual({ type: "none" });
  });

  it("← and Esc close the innermost level only: a submenu goes back to its row before the menu goes", () => {
    expect(decideMenuKey("out", sub)).toEqual({ type: "close-submenu" });
    expect(decideMenuKey("close", sub)).toEqual({ type: "close-submenu" });
    expect(decideMenuKey("out", root)).toEqual({ type: "none" });
    expect(decideMenuKey("close", root)).toEqual({ type: "close-menu" });
  });

  it("Tab leaves the whole menu, from any level", () => {
    expect(decideMenuKey("leave", root)).toEqual({ type: "close-menu" });
    expect(decideMenuKey("leave", sub)).toEqual({ type: "close-menu" });
  });

  it("does not decide → : the row that owns a submenu opens it", () => {
    expect(decideMenuKey("into", root)).toEqual({ type: "none" });
  });
});

/**
 * A stand-in for the elements the menu code touches. `closest` answers by
 * selector, the way the DOM would for `role="menu"` / `role="menuitem*"` / a
 * text field; there is no DOM here to ask.
 */
type Kind = "menu" | "row" | "field" | "plain";
interface Fake {
  kind: Kind;
  owner: Fake | null;
  disabled: boolean;
  ariaDisabled: boolean;
  selected: boolean;
  parts: Fake[];
  focus: ReturnType<typeof vi.fn>;
  scrollIntoView: ReturnType<typeof vi.fn>;
  /** 4 (`DOCUMENT_POSITION_FOLLOWING`) when the node it is asked about comes after it, 2 when before. */
  before: boolean;
  closest(selector: string): Fake | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  querySelector(selector: string): Fake | null;
  querySelectorAll(selector: string): Fake[];
  compareDocumentPosition(other: unknown): number;
  contains(other: unknown): boolean;
}

function fake(kind: Kind, owner: Fake | null = null, init: { disabled?: boolean; ariaDisabled?: boolean; selected?: boolean; before?: boolean } = {}): Fake {
  const el: Fake = {
    kind,
    owner,
    disabled: init.disabled === true,
    ariaDisabled: init.ariaDisabled === true,
    selected: init.selected === true,
    before: init.before === true,
    parts: [],
    focus: vi.fn(),
    scrollIntoView: vi.fn(),
    closest(selector) {
      if (selector === '[role="menu"]') return el.kind === "menu" ? el : el.owner;
      if (selector === MENU_ROW) return el.kind === "row" ? el : null;
      if (selector === EDITABLE) return el.kind === "field" ? el : null;
      return null;
    },
    hasAttribute: (name) => (name === "disabled" && el.disabled) || (name === "data-selected" && el.selected),
    getAttribute: (name) => (name === "aria-disabled" && el.ariaDisabled ? "true" : null),
    querySelector: (selector) => (selector === EDITABLE ? (el.parts.find((part) => part.kind === "field") ?? null) : null),
    querySelectorAll: (selector) => (selector === MENU_ROW ? el.parts.filter((part) => part.kind === "row") : []),
    compareDocumentPosition: () => (el.before ? 4 : 2),
    contains: (other) => other === el || el.parts.some((part) => part === other || part.contains(other)),
  };
  return el;
}

/** A menu of `n` rows, and a submenu with one row inside it, which — like the DOM's — the menu's own `querySelectorAll` also finds. */
function menuOf(n: number, options: { disabledAt?: number } = {}) {
  const menu = fake("menu");
  const rows = Array.from({ length: n }, (_, at) => fake("row", menu, { disabled: at === options.disabledAt }));
  const submenu = fake("menu", menu);
  const nestedRow = fake("row", submenu);
  submenu.parts = [nestedRow];
  menu.parts = [...rows, submenu, nestedRow];
  return { menu, rows, submenu, nestedRow };
}

const asElement = (value: Fake) => value as unknown as HTMLElement;

const keyEvent = (key: string, target: Fake | null, extra: Record<string, unknown> = {}) => ({
  ...press(key, extra),
  target: target as unknown as EventTarget | null,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

describe("menuRows", () => {
  it("is the rows a level owns: not a submenu's, not a disabled one's", () => {
    const { menu, rows, nestedRow } = menuOf(4, { disabledAt: 1 });
    rows[2]!.ariaDisabled = true;
    const owned = menuRows(asElement(menu));
    expect(owned).toEqual([rows[0], rows[3]]);
    expect(owned).not.toContain(nestedRow);
  });

  it("finds a submenu's own rows from the submenu", () => {
    const { submenu, nestedRow } = menuOf(2);
    expect(menuRows(asElement(submenu))).toEqual([nestedRow]);
  });
});

describe("handleMenuKeyDown", () => {
  it("↓ moves focus to the next row and takes the key from the page and from the level above", () => {
    const { menu, rows } = menuOf(3);
    const event = keyEvent("ArrowDown", rows[0]!);
    expect(handleMenuKeyDown(event, asElement(menu), { nested: false })).toBe(true);
    expect(rows[1]!.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(rows[1]!.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("wraps: ↓ from the last row is the first, ↑ from the first is the last", () => {
    const { menu, rows } = menuOf(3);
    handleMenuKeyDown(keyEvent("ArrowDown", rows[2]!), asElement(menu), { nested: false });
    handleMenuKeyDown(keyEvent("ArrowUp", rows[0]!), asElement(menu), { nested: false });
    expect(rows[0]!.focus).toHaveBeenCalledTimes(1);
    expect(rows[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it("Home and End jump to the ends", () => {
    const { menu, rows } = menuOf(4);
    handleMenuKeyDown(keyEvent("End", rows[1]!), asElement(menu), { nested: false });
    handleMenuKeyDown(keyEvent("Home", rows[2]!), asElement(menu), { nested: false });
    expect(rows[3]!.focus).toHaveBeenCalledTimes(1);
    expect(rows[0]!.focus).toHaveBeenCalledTimes(1);
  });

  it("skips a disabled row", () => {
    const { menu, rows } = menuOf(3, { disabledAt: 1 });
    handleMenuKeyDown(keyEvent("ArrowDown", rows[0]!), asElement(menu), { nested: false });
    expect(rows[1]!.focus).not.toHaveBeenCalled();
    expect(rows[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it("with focus on the panel itself — a pointer opened it — ↓ enters on the first row and ↑ on the last", () => {
    const { menu, rows } = menuOf(3);
    handleMenuKeyDown(keyEvent("ArrowDown", menu), asElement(menu), { nested: false });
    handleMenuKeyDown(keyEvent("ArrowUp", menu), asElement(menu), { nested: false });
    expect(rows[0]!.focus).toHaveBeenCalledTimes(1);
    expect(rows[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves a text field its own keys, and lets ↓ hand over to the rows under a search box", () => {
    const { menu, rows } = menuOf(3);
    const field = fake("field", menu);
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "Home", "End", "Tab"]) {
      const event = keyEvent(key, field);
      expect(handleMenuKeyDown(event, asElement(menu), { nested: false, closeMenu: vi.fn() })).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    const down = keyEvent("ArrowDown", field);
    expect(handleMenuKeyDown(down, asElement(menu), { nested: false })).toBe(true);
    expect(rows[0]!.focus).toHaveBeenCalledTimes(1);
    expect(down.preventDefault).toHaveBeenCalled();
  });

  it("↓ from a search box enters the list on its current choice, so a long list does not restart from the top", () => {
    const { menu, rows } = menuOf(4);
    const field = fake("field", menu, { before: true });
    rows[2]!.selected = true;
    handleMenuKeyDown(keyEvent("ArrowDown", field), asElement(menu), { nested: false });
    expect(rows[2]!.focus).toHaveBeenCalledTimes(1);
    expect(rows[0]!.focus).not.toHaveBeenCalled();
    // Nothing chosen: the first row. Nothing to enter: the key is not taken.
    const plain = menuOf(3);
    handleMenuKeyDown(keyEvent("ArrowDown", fake("field", plain.menu)), asElement(plain.menu), { nested: false });
    expect(plain.rows[0]!.focus).toHaveBeenCalledTimes(1);
    const none = menuOf(0);
    const down = keyEvent("ArrowDown", fake("field", none.menu));
    expect(handleMenuKeyDown(down, asElement(none.menu), { nested: false })).toBe(false);
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it("↑ from the first row goes back up to the search box above the rows, instead of wrapping past it", () => {
    const { menu, rows } = menuOf(3);
    const field = fake("field", menu, { before: true });
    menu.parts = [field, ...menu.parts];
    const event = keyEvent("ArrowUp", rows[0]!);
    expect(handleMenuKeyDown(event, asElement(menu), { nested: false })).toBe(true);
    expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(rows[2]!.focus).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    // From any other row it is an ordinary ↑.
    handleMenuKeyDown(keyEvent("ArrowUp", rows[2]!), asElement(menu), { nested: false });
    expect(rows[1]!.focus).toHaveBeenCalledTimes(1);
  });

  it("…but a field below the rows, or in a submenu, is not the way up", () => {
    const below = menuOf(3);
    const under = fake("field", below.menu, { before: false });
    below.menu.parts = [...below.menu.parts, under];
    handleMenuKeyDown(keyEvent("ArrowUp", below.rows[0]!), asElement(below.menu), { nested: false });
    expect(under.focus).not.toHaveBeenCalled();
    expect(below.rows[2]!.focus).toHaveBeenCalledTimes(1);

    const inner = menuOf(3);
    const nestedField = fake("field", inner.submenu, { before: true });
    inner.menu.parts = [nestedField, ...inner.menu.parts];
    handleMenuKeyDown(keyEvent("ArrowUp", inner.rows[0]!), asElement(inner.menu), { nested: false });
    expect(nestedField.focus).not.toHaveBeenCalled();
    expect(inner.rows[2]!.focus).toHaveBeenCalledTimes(1);
  });

  it("← and Esc in a submenu close it — from a row and from its search box — and → does not", () => {
    const { submenu, nestedRow } = menuOf(2);
    const field = fake("field", submenu);
    const closeSubmenu = vi.fn();
    for (const target of [nestedRow, field]) {
      expect(handleMenuKeyDown(keyEvent("Escape", target), asElement(submenu), { nested: true, closeSubmenu })).toBe(true);
    }
    expect(handleMenuKeyDown(keyEvent("ArrowLeft", nestedRow), asElement(submenu), { nested: true, closeSubmenu })).toBe(true);
    expect(closeSubmenu).toHaveBeenCalledTimes(3);
    // ← in a text field is the caret's.
    expect(handleMenuKeyDown(keyEvent("ArrowLeft", field), asElement(submenu), { nested: true, closeSubmenu })).toBe(false);
    expect(handleMenuKeyDown(keyEvent("ArrowRight", nestedRow), asElement(submenu), { nested: true, closeSubmenu })).toBe(false);
    expect(closeSubmenu).toHaveBeenCalledTimes(3);
  });

  it("← at the top level has no level to go back to", () => {
    const { menu, rows } = menuOf(2);
    const event = keyEvent("ArrowLeft", rows[0]!);
    expect(handleMenuKeyDown(event, asElement(menu), { nested: false })).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("Tab on a row closes the menu; on anything else in it, it is Tab", () => {
    const { menu, rows } = menuOf(2);
    const closeMenu = vi.fn();
    const onRow = keyEvent("Tab", rows[0]!);
    expect(handleMenuKeyDown(onRow, asElement(menu), { nested: false, closeMenu })).toBe(true);
    expect(onRow.preventDefault).toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(handleMenuKeyDown(keyEvent("Tab", fake("plain", menu)), asElement(menu), { nested: false, closeMenu })).toBe(false);
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("a key from a submenu is that submenu's: the level above does not move its own focus for it — but Tab still closes everything", () => {
    const { menu, rows, nestedRow } = menuOf(3);
    const closeMenu = vi.fn();
    expect(handleMenuKeyDown(keyEvent("ArrowDown", nestedRow), asElement(menu), { nested: false, closeMenu })).toBe(false);
    expect(handleMenuKeyDown(keyEvent("Escape", nestedRow), asElement(menu), { nested: false, closeMenu })).toBe(false);
    expect(rows.every((row) => row.focus.mock.calls.length === 0)).toBe(true);
    expect(handleMenuKeyDown(keyEvent("Tab", nestedRow), asElement(menu), { nested: false, closeMenu })).toBe(true);
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("does not take a key it cannot act on", () => {
    const { menu, rows } = menuOf(2);
    // No callback to close with: the level above gets the key.
    expect(handleMenuKeyDown(keyEvent("Tab", rows[0]!), asElement(menu), { nested: true })).toBe(false);
    expect(handleMenuKeyDown(keyEvent("Escape", rows[0]!), asElement(menu), { nested: true })).toBe(false);
    // Nothing to focus.
    const empty = menuOf(0);
    expect(handleMenuKeyDown(keyEvent("ArrowDown", empty.menu), asElement(empty.menu), { nested: false })).toBe(false);
    // Not a menu key, or not ours.
    expect(handleMenuKeyDown(keyEvent("Enter", rows[0]!), asElement(menu), { nested: false })).toBe(false);
    expect(handleMenuKeyDown(keyEvent("ArrowDown", rows[0]!, { metaKey: true }), asElement(menu), { nested: false })).toBe(false);
    expect(handleMenuKeyDown(keyEvent("ArrowDown", rows[0]!, { isComposing: true }), asElement(menu), { nested: false })).toBe(false);
    expect(rows.every((row) => row.focus.mock.calls.length === 0)).toBe(true);
  });
});

describe("focus helpers", () => {
  it("focusRow keeps the page from scrolling, and brings a row in a scrolling list into view", () => {
    const row = fake("row");
    focusRow(asElement(row));
    expect(row.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const quiet = fake("row");
    focusRow(asElement(quiet), false);
    expect(quiet.scrollIntoView).not.toHaveBeenCalled();
  });

  it("a submenu is entered on its current choice, else its first row", () => {
    const row = (name: string, selected = false) => ({ name, hasAttribute: (attribute: string) => attribute === "data-selected" && selected });
    expect(entryRow([row("a"), row("b", true), row("c")])?.name).toBe("b");
    expect(entryRow([row("a"), row("b")])?.name).toBe("a");
    expect(entryRow([])).toBeUndefined();
  });

  it("opens on the first row for a keyboard, the last for ↑, the panel for a pointer", () => {
    expect(initialFocusTarget("first", ["a", "b"], "panel")).toBe("a");
    expect(initialFocusTarget("last", ["a", "b"], "panel")).toBe("b");
    expect(initialFocusTarget("panel", ["a", "b"], "panel")).toBe("panel");
    // A menu with no rows yet still gets focus, on itself.
    expect(initialFocusTarget("first", [], "panel")).toBe("panel");
    expect(initialFocusTarget("last", [], "panel")).toBe("panel");
  });

  it("↓ / ↑ from outside the menu enter on its first / last row, and nothing else does", () => {
    expect(arrowEntry(press("ArrowDown"))).toBe("first");
    expect(arrowEntry(press("ArrowUp"))).toBe("last");
    expect(arrowEntry(press("ArrowRight"))).toBeNull();
    expect(arrowEntry(press("Enter"))).toBeNull();
    expect(arrowEntry(press("ArrowDown", { metaKey: true }))).toBeNull();
  });

  it("a held Enter is not a fresh one", () => {
    expect(isHeldEnter({ key: "Enter", repeat: true })).toBe(true);
    expect(isHeldEnter({ key: "Enter", repeat: false })).toBe(false);
    expect(isHeldEnter({ key: "ArrowDown", repeat: true })).toBe(false);
  });

  it("knows when focus fell to the page", () => {
    const body = {};
    expect(focusIsLost(body, body)).toBe(true);
    expect(focusIsLost(null, body)).toBe(true);
    expect(focusIsLost({}, body)).toBe(false);
  });

  it("finds a target that sits in a submenu of the panel, not in the panel's own level", () => {
    const { menu, rows, submenu, nestedRow } = menuOf(2);
    expect(inSubmenu(nestedRow as unknown as EventTarget, asElement(menu))).toBe(true);
    expect(inSubmenu(submenu as unknown as EventTarget, asElement(menu))).toBe(true);
    expect(inSubmenu(rows[0] as unknown as EventTarget, asElement(menu))).toBe(false);
    expect(inSubmenu(menu as unknown as EventTarget, asElement(menu))).toBe(false);
    expect(inSubmenu(null, asElement(menu))).toBe(false);
  });
});

describe("shouldRestoreFocus", () => {
  const body = { id: "body" };
  const trigger = { id: "trigger" };

  it("gives focus back when the row that had it went away, or it never left the trigger", () => {
    expect(shouldRestoreFocus({ wanted: true, active: body, body, trigger })).toBe(true);
    expect(shouldRestoreFocus({ wanted: true, active: null, body, trigger })).toBe(true);
    expect(shouldRestoreFocus({ wanted: true, active: trigger, body, trigger })).toBe(true);
  });

  it("does not take focus from something that claimed it: a field the row opened, or where the pointer went", () => {
    expect(shouldRestoreFocus({ wanted: true, active: { id: "rename-field" }, body, trigger })).toBe(false);
    expect(shouldRestoreFocus({ wanted: false, active: body, body, trigger })).toBe(false);
  });
});

describe("panelKey: the popover's own key listener", () => {
  const body = { id: "body" };
  const pressAt = (key: string, target: unknown, extra: Record<string, unknown> = {}) => ({
    ...press(key, { repeat: false, ...extra }),
    target: target as EventTarget | null,
  });
  const decide = (menu: Fake, event: ReturnType<typeof pressAt>, options: { menu?: boolean } = {}) =>
    panelKey(event as never, asElement(menu), { menu: options.menu ?? true, body });

  it("closes on Esc, from wherever focus is", () => {
    const { menu, rows } = menuOf(2);
    expect(decide(menu, pressAt("Escape", rows[0]!))).toEqual({ type: "close" });
    expect(decide(menu, pressAt("Escape", menu))).toEqual({ type: "close" });
    expect(decide(menu, pressAt("Escape", body))).toEqual({ type: "close" });
  });

  it("leaves Esc to a submenu it came out of, which closes first — and closes for itself once that has", () => {
    const { menu, nestedRow, submenu } = menuOf(2);
    expect(decide(menu, pressAt("Escape", nestedRow))).toEqual({ type: "none" });
    expect(decide(menu, pressAt("Escape", fake("field", submenu)))).toEqual({ type: "none" });
  });

  it("does not take an input method's Esc", () => {
    const { menu, rows } = menuOf(2);
    expect(decide(menu, pressAt("Escape", rows[0]!, { isComposing: true }))).toEqual({ type: "none" });
  });

  it("puts focus back on a row with ↓ / ↑ once it has fallen to the page", () => {
    const { menu, rows } = menuOf(3);
    expect(decide(menu, pressAt("ArrowDown", body))).toEqual({ type: "enter", row: rows[0] });
    expect(decide(menu, pressAt("ArrowUp", body))).toEqual({ type: "enter", row: rows[2] });
    expect(decide(menu, pressAt("ArrowDown", null))).toEqual({ type: "enter", row: rows[0] });
  });

  it("leaves the arrows alone while focus is somewhere, and in a popover that is not a menu", () => {
    const { menu, rows } = menuOf(3);
    expect(decide(menu, pressAt("ArrowDown", rows[1]!)).type).not.toBe("enter");
    expect(decide(menu, pressAt("ArrowDown", body), { menu: false }).type).not.toBe("enter");
    // No row to put it on.
    expect(decide(menuOf(0).menu, pressAt("ArrowDown", body)).type).not.toBe("enter");
  });

  it("lets a row's shortcut answer wherever focus is", () => {
    const { menu, rows } = menuOf(2);
    expect(decide(menu, pressAt("D", rows[0]!))).toEqual({ type: "shortcut", key: "d" });
    expect(decide(menu, pressAt("d", body))).toEqual({ type: "shortcut", key: "d" });
    expect(decide(menu, pressAt("d", menu))).toEqual({ type: "shortcut", key: "d" });
  });

  it("leaves a text box its typing", () => {
    const { menu } = menuOf(2);
    const field = fake("field", menu);
    menu.parts.push(field);
    expect(decide(menu, pressAt("d", field))).toEqual({ type: "none" });
    expect(decide(menu, pressAt("Enter", field))).toEqual({ type: "none" });
  });

  it("lets Enter act on the row that has focus, not on whichever row carries the ↵ shortcut", () => {
    const { menu, rows } = menuOf(3);
    expect(decide(menu, pressAt("Enter", rows[1]!))).toEqual({ type: "none" });
    // With nothing focused inside the panel, Enter is the shortcut's.
    expect(decide(menu, pressAt("Enter", menu))).toEqual({ type: "shortcut", key: "enter" });
    expect(decide(menu, pressAt("Enter", body))).toEqual({ type: "shortcut", key: "enter" });
    expect(decide(menu, pressAt("Enter", { closest: () => null }))).toEqual({ type: "shortcut", key: "enter" });
  });

  it("leaves chords, held keys and input-method keys alone", () => {
    const { menu, rows } = menuOf(2);
    expect(decide(menu, pressAt("d", rows[0]!, { metaKey: true }))).toEqual({ type: "none" });
    expect(decide(menu, pressAt("d", rows[0]!, { repeat: true }))).toEqual({ type: "none" });
    expect(decide(menu, pressAt("d", rows[0]!, { isComposing: true }))).toEqual({ type: "none" });
  });
});
