import type { KeyboardEvent, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, type HookHandle } from "@/lib/testing/renderHook";
import { focusableIn, tabTarget, useModalFocus } from "./useModalFocus";

describe("tabTarget", () => {
  const items = ["a", "b", "c"];

  it("sends Tab off the last control to the first, and ⇧Tab off the first to the last", () => {
    expect(tabTarget(items, "c", false)).toBe("a");
    expect(tabTarget(items, "a", true)).toBe("c");
  });

  it("leaves the moves that stay inside to the browser", () => {
    expect(tabTarget(items, "a", false)).toBeNull();
    expect(tabTarget(items, "b", false)).toBeNull();
    expect(tabTarget(items, "b", true)).toBeNull();
    expect(tabTarget(items, "c", true)).toBeNull();
  });

  it("takes focus that is on the dialog itself, or nowhere in it, to the near end", () => {
    expect(tabTarget(items, "the dialog", false)).toBe("a");
    expect(tabTarget(items, "the dialog", true)).toBe("c");
  });

  it("has nowhere to send Tab in a dialog with no controls", () => {
    expect(tabTarget([], "the dialog", false)).toBeNull();
    expect(tabTarget([], "the dialog", true)).toBeNull();
  });

  it("keeps a lone control focused", () => {
    expect(tabTarget(["only"], "only", false)).toBe("only");
    expect(tabTarget(["only"], "only", true)).toBe("only");
  });
});

interface FakeElement {
  name: string;
  isConnected: boolean;
  focus: () => void;
  getClientRects: () => object[];
  querySelectorAll: (selector: string) => FakeElement[];
  contains: (node: unknown) => boolean;
}

/** Stands in for the page: `focus()` moves `activeElement`, like a real element's. */
class Page {
  readonly body = { name: "body" };
  activeElement: unknown = this.body;
  readonly log: string[] = [];

  element(name: string, options: { connected?: boolean; visible?: boolean } = {}): FakeElement {
    const element: FakeElement = {
      name,
      isConnected: options.connected ?? true,
      focus: () => {
        this.activeElement = element;
        this.log.push(name);
      },
      getClientRects: () => (options.visible === false ? [] : [{}]),
      querySelectorAll: () => [],
      contains: (node) => node === element || element.querySelectorAll("*").includes(node as FakeElement),
    };
    return element;
  }
}

let doc: Page;
const handles: Array<HookHandle<unknown, unknown>> = [];

beforeEach(() => {
  doc = new Page();
  vi.stubGlobal("document", doc);
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.unmount();
  vi.unstubAllGlobals();
});

async function mount(dialog: FakeElement, open: boolean) {
  const ref = { current: dialog } as unknown as RefObject<HTMLElement | null>;
  const hook = await renderHook((props: { open: boolean }) => useModalFocus(props.open, ref), { props: { open } });
  handles.push(hook as unknown as HookHandle<unknown, unknown>);
  return hook;
}

/** A Tab as the dialog hears it: from `target`, which is wherever focus is unless said otherwise. */
const tab = (shiftKey = false, target: unknown = doc.activeElement) => {
  const prevented = vi.fn();
  return { event: { key: "Tab", shiftKey, target, preventDefault: prevented } as unknown as KeyboardEvent<HTMLElement>, prevented };
};

describe("useModalFocus", () => {
  it("moves focus into the dialog when it opens, and back to what had it when it closes", async () => {
    const opener = doc.element("gear");
    const dialog = doc.element("dialog");
    opener.focus();
    doc.log.length = 0;

    const hook = await mount(dialog, false);
    expect(doc.log).toEqual([]);
    await hook.rerender({ open: true });
    expect(doc.log).toEqual(["dialog"]);
    await hook.rerender({ open: false });
    expect(doc.log).toEqual(["dialog", "gear"]);
    expect(doc.activeElement).toBe(opener);
  });

  it("puts focus back after every opening, from wherever each one started", async () => {
    const composer = doc.element("composer");
    const search = doc.element("search");
    const dialog = doc.element("dialog");
    const hook = await mount(dialog, false);

    composer.focus();
    await hook.rerender({ open: true });
    await hook.rerender({ open: false });
    expect(doc.activeElement).toBe(composer);

    search.focus();
    await hook.rerender({ open: true });
    await hook.rerender({ open: false });
    expect(doc.activeElement).toBe(search);
  });

  it("does not try to focus something that is gone, or the page body", async () => {
    const dialog = doc.element("dialog");
    const gone = doc.element("gone");
    gone.focus();
    const hook = await mount(dialog, false);
    await hook.rerender({ open: true });
    gone.isConnected = false;
    doc.log.length = 0;
    await hook.rerender({ open: false });
    expect(doc.log).toEqual([]);

    // Nothing had focus (the page body): nothing to give back.
    doc.activeElement = doc.body;
    await hook.rerender({ open: true });
    doc.log.length = 0;
    await hook.rerender({ open: false });
    expect(doc.log).toEqual([]);
  });

  it("keeps Tab inside: off the last control to the first, ⇧Tab off the first to the last", async () => {
    const [first, middle, last] = [doc.element("first"), doc.element("middle"), doc.element("last")];
    const dialog = doc.element("dialog");
    dialog.querySelectorAll = () => [first, middle, last];
    const hook = await mount(dialog, true);
    const onKeyDown = hook.result.current;

    last.focus();
    const forward = tab();
    onKeyDown(forward.event);
    expect(forward.prevented).toHaveBeenCalledTimes(1);
    expect(doc.activeElement).toBe(first);

    const backward = tab(true);
    onKeyDown(backward.event);
    expect(backward.prevented).toHaveBeenCalledTimes(1);
    expect(doc.activeElement).toBe(last);
  });

  it("leaves Tab between two controls to the browser, and other keys alone", async () => {
    const [first, middle] = [doc.element("first"), doc.element("middle")];
    const dialog = doc.element("dialog");
    dialog.querySelectorAll = () => [first, middle, doc.element("last")];
    const hook = await mount(dialog, true);
    middle.focus();

    const inside = tab();
    hook.result.current(inside.event);
    expect(inside.prevented).not.toHaveBeenCalled();

    const other = { key: "a", shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent<HTMLElement>;
    hook.result.current(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves the Tab of a dialog opened from inside it (drawn elsewhere, heard here) to that dialog", async () => {
    const [first, last] = [doc.element("first"), doc.element("last")];
    const dialog = doc.element("dialog");
    dialog.querySelectorAll = () => [first, last];
    const inPortal = doc.element("in-portal");
    const hook = await mount(dialog, true);
    inPortal.focus();

    // Focus is on none of the dialog's controls, which is what would send it to the first.
    const fromPortal = tab(false, inPortal);
    hook.result.current(fromPortal.event);
    expect(fromPortal.prevented).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(inPortal);
  });

  it("does not count a control that is not on screen", () => {
    const shown = doc.element("shown");
    const hidden = doc.element("hidden", { visible: false });
    expect(focusableIn({ querySelectorAll: () => [hidden, shown] } as unknown as ParentNode)).toEqual([shown]);
  });
});
