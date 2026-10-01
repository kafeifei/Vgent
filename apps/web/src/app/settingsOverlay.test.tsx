import { StrictMode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTree, type Tree, type TreeNode } from "@/lib/testing/renderTree";
import { SettingsOverlay } from "./SettingsOverlay";

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

async function show(element: Parameters<typeof renderTree>[0]) {
  const tree = await renderTree(element);
  trees.push(tree);
  return tree;
}

const overlay = (onClose: () => void = () => undefined) => createElement(SettingsOverlay, { onClose, children: createElement("p", null, "设置的内容") });

describe("SettingsOverlay", () => {
  it("is a modal dialog that can hold focus itself, named 设置", () => {
    const markup = renderToStaticMarkup(overlay());
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="设置"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain("设置的内容");
    expect(markup).toContain('title="关闭"');
  });

  it("takes focus when it opens, and gives it back to what had it when it closes", async () => {
    // The page: a button (the gear, or the field ⌘, was pressed in) that has focus.
    const page = (open: boolean) => createElement("div", null, createElement("button", { type: "button" }, "打开设置"), open ? overlay() : null);
    const tree = await show(page(false));
    const opener = tree.byText("打开设置");
    opener.focus();
    const document = tree.container.ownerDocument;
    expect(document.activeElement).toBe(opener);

    await tree.rerender(page(true));
    const dialog = tree.byRole("dialog")[0];
    expect(dialog).toBeDefined();
    expect(document.activeElement).toBe(dialog);

    await tree.rerender(page(false));
    expect(tree.byRole("dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("gives focus back under StrictMode too, where opening runs its effects twice", async () => {
    // The page as the shell draws it: `inert` behind the open dialog.
    const page = (open: boolean) =>
      createElement(
        StrictMode,
        null,
        createElement("div", { inert: open || undefined }, createElement("button", { type: "button" }, "打开设置")),
        open ? overlay() : null,
      );
    const tree = await show(page(false));
    const opener = tree.byText("打开设置");
    // Like a browser, which does not move focus into an inert subtree: StrictMode's
    // rehearsed close gives focus back while the page is still inert, and it stays in the dialog.
    const focus = opener.focus.bind(opener);
    opener.focus = () => {
      for (let node: TreeNode | null = opener; node != null; node = node.parentNode) if (node.hasAttribute("inert")) return;
      focus();
    };
    opener.focus();
    const document = tree.container.ownerDocument;

    await tree.rerender(page(true));
    expect(document.activeElement).toBe(tree.byRole("dialog")[0]);

    await tree.rerender(page(false));
    expect(document.activeElement).toBe(opener);
  });

  it("does not give focus back to something that has left the page while the dialog was open", async () => {
    const page = (state: "closed" | "open" | "open, gear gone") =>
      createElement(
        "div",
        null,
        state === "open, gear gone" ? null : createElement("button", { key: "gear", type: "button" }, "打开设置"),
        state === "closed" ? null : overlay(),
      );
    const tree = await show(page("closed"));
    const gear = tree.byText("打开设置");
    gear.focus();
    await tree.rerender(page("open"));
    await tree.rerender(page("open, gear gone"));
    expect(gear.isConnected).toBe(false);

    await tree.rerender(page("closed"));
    // Focus stays wherever the dialog left it; it is not sent to a node that is no longer there.
    expect(tree.container.ownerDocument.activeElement).not.toBe(gear);
  });

  it("closes from the close button, and from a press on the dimmed area — not from one inside the dialog", async () => {
    const onClose = vi.fn();
    const tree = await show(overlay(onClose));
    const [backdrop] = tree.byRole("presentation");
    const [dialog] = tree.byRole("dialog");
    expect(backdrop).toBeDefined();
    if (backdrop == null || dialog == null) return;

    // A press that lands in the dialog bubbles to the backdrop, but its target is not the backdrop.
    await tree.fire(dialog, "onMouseDown", { target: dialog });
    expect(onClose).not.toHaveBeenCalled();
    await tree.fire(backdrop, "onMouseDown", { target: backdrop });
    expect(onClose).toHaveBeenCalledTimes(1);

    await tree.click(tree.all((node) => node.getAttribute("title") === "关闭")[0] as never);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
