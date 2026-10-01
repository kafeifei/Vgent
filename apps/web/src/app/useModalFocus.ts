import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";

/**
 * What a dialog owes the keyboard: focus goes in when it opens, Tab stays in it,
 * and focus goes back to where it came from when it closes. The page behind is
 * kept out of reach by the caller (`inert`), which is also what stops Tab from
 * wandering into it — the loop here only stops it from leaving through the
 * dialog's own ends.
 *
 * This is deliberately not `components/ui/dialog.tsx`. That is Radix's modal,
 * which traps focus and pointer events for the whole document: the ⌘K palette
 * opened over the settings would not take a click or a keystroke, and Esc would
 * close the settings under a popover that should have taken it first.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isFocusable = (value: unknown): value is HTMLElement => value != null && typeof (value as HTMLElement).focus === "function";

/** The controls inside `root` that Tab can reach, in order. */
export function focusableIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

/**
 * Where Tab (or ⇧Tab) has to be sent to stay in the dialog, or `null` when the
 * browser's own next stop is inside it anyway: off the last control goes to the
 * first, off the first (or off the dialog itself) to the last.
 */
export function tabTarget<T>(items: readonly T[], active: unknown, backwards: boolean): T | null {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return null;
  const at = items.indexOf(active as T);
  if (backwards) return at <= 0 ? last : null;
  return at === -1 || at === items.length - 1 ? first : null;
}

/**
 * `open` is whether the dialog is on screen; `container` is its element (give it
 * `tabIndex={-1}`, so it can hold focus itself). Returns the `onKeyDown` for it.
 */
export function useModalFocus(open: boolean, container: RefObject<HTMLElement | null>): (event: KeyboardEvent<HTMLElement>) => void {
  const opener = useRef<HTMLElement | null>(null);

  // Before the browser has had a chance to move focus off what the dialog
  // covers: whatever has it now is where it goes back to. Never something in the
  // dialog itself: StrictMode opens it twice, and its rehearsed close cannot give
  // focus back to the page while that is still `inert`, so the second opening
  // finds focus in the dialog — the first one's reading stands.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (container.current?.contains(active as Node | null) !== true) {
      opener.current = isFocusable(active) && active !== document.body ? active : null;
    }
    container.current?.focus();
  }, [open, container]);

  // After the commit that closed it, when the page behind is reachable again.
  // `opener` is not cleared here — that rehearsed close runs this too — but
  // every opening reads it afresh.
  useEffect(() => {
    if (!open) return;
    return () => {
      const target = opener.current;
      if (target?.isConnected === true) target.focus();
    };
  }, [open]);

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab") return;
      const root = container.current;
      if (root == null) return;
      // A dialog opened from inside this one is drawn elsewhere in the DOM (a
      // portal), but its keys still bubble up here through React. They are its own.
      if (!root.contains(event.target as Node | null)) return;
      const target = tabTarget(focusableIn(root), document.activeElement, event.shiftKey);
      if (target == null) return;
      event.preventDefault();
      target.focus();
    },
    [container],
  );
}
