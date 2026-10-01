import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import { AllowlistSection } from "./AllowlistSection";

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

const show = async (props: { entries: string[]; saving?: boolean; onRemove?: (entry: string) => void }) => {
  const tree = await renderTree(createElement(AllowlistSection, { saving: false, onRemove: () => undefined, ...props }));
  trees.push(tree);
  return tree;
};

describe("「一直允许」 in the settings", () => {
  it("is no section at all while nothing is allowed for good", async () => {
    const tree = await show({ entries: [] });
    expect(tree.text()).toBe("");
  });

  it("lists each entry as it is stored", async () => {
    const tree = await show({ entries: ["bash(git status)", "write"] });
    expect(tree.text()).toContain("一直允许");
    expect(tree.text()).toContain("bash(git status)");
    expect(tree.text()).toContain("write");
  });

  it("takes exactly the entry whose button is pressed off the list", async () => {
    const onRemove = vi.fn();
    const tree = await show({ entries: ["bash(git status)", "write"], onRemove });
    const buttons = tree.all((node) => node.tagName === "BUTTON");
    expect(buttons).toHaveLength(2);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("移除 write");
    await tree.click(buttons[1]!);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("write");
  });

  it("does not let an entry go while a save is in flight", async () => {
    const tree = await show({ entries: ["write"], saving: true });
    expect(tree.all((node) => node.tagName === "BUTTON")[0]?.props.disabled).toBe(true);
  });
});
