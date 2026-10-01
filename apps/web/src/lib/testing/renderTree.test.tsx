import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTree, type Tree } from "./renderTree";

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

async function show(element: Parameters<typeof renderTree>[0]) {
  const tree = await renderTree(element);
  trees.push(tree);
  return tree;
}

describe("renderTree", () => {
  it("draws elements, text and attributes, and finds them", async () => {
    const tree = await show(
      createElement("div", null, createElement("h1", { title: "标题" }, "你好"), createElement("button", { type: "button", role: "menuitem" }, "确定", createElement("span", null, "K"))),
    );
    expect(tree.text()).toBe("你好确定K");
    expect(tree.byText("你好").getAttribute("title")).toBe("标题");
    expect(tree.byRole("menuitem").map((node) => node.textContent)).toEqual(["确定K"]);
    expect(tree.byRole("menuitem", /确/)).toHaveLength(1);
    expect(tree.byRole("menuitem", "别的")).toHaveLength(0);
    expect(() => tree.byText("不存在")).toThrow(/found 0/);
  });

  it("delivers a click to the element and up through its ancestors, until one stops it", async () => {
    const log: string[] = [];
    const tree = await show(
      createElement(
        "div",
        { onClick: () => log.push("outer") },
        createElement(
          "div",
          { onClick: (event: { stopPropagation: () => void }) => (log.push("middle"), event.stopPropagation()) },
          createElement("button", { onClick: () => log.push("button") }, createElement("span", null, "点我")),
        ),
      ),
    );
    await tree.click(tree.byText("点我"));
    expect(log).toEqual(["button", "middle"]);
  });

  it("gives a disabled button no click, as React does, and other handlers what they were told", async () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const tree = await show(createElement("div", null, createElement("button", { disabled: true, onClick, onKeyDown }, "灰的")));
    await tree.click(tree.byText("灰的"));
    expect(onClick).not.toHaveBeenCalled();
    await tree.fire(tree.byText("灰的"), "onKeyDown", { key: "Enter" });
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter", type: "keydown" }));
  });

  it("commits state a click set, and a rerender's new elements", async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", { onClick: () => setCount((value) => value + 1) }, `点了 ${count} 次`);
    }
    const tree = await show(createElement(Counter));
    await tree.click(tree.byText("点了 0 次"));
    await tree.click(tree.byText("点了 1 次"));
    expect(tree.text()).toBe("点了 2 次");
    await tree.rerender(createElement("p", null, "换了"));
    expect(tree.text()).toBe("换了");
  });

  it("marks what React removed as no longer connected, and moves focus like an element does", async () => {
    const tree = await show(createElement("div", null, createElement("button", { key: "a" }, "甲"), createElement("button", { key: "b" }, "乙")));
    const a = tree.byText("甲");
    a.focus();
    expect(tree.container.ownerDocument.activeElement).toBe(a);
    await tree.rerender(createElement("div", null, createElement("button", { key: "b" }, "乙")));
    expect(a.isConnected).toBe(false);
    expect(tree.byText("乙").isConnected).toBe(true);
  });

  it("puts the globals back once the last tree is gone", async () => {
    expect(Reflect.has(globalThis, "document")).toBe(false);
    const first = await renderTree(createElement("div"));
    const second = await renderTree(createElement("div"));
    expect(Reflect.has(globalThis, "document")).toBe(true);
    await first.unmount();
    expect(Reflect.has(globalThis, "document")).toBe(true);
    await second.unmount();
    expect(Reflect.has(globalThis, "document")).toBe(false);
    expect(Reflect.has(globalThis, "window")).toBe(false);
  });
});
