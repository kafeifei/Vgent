import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@/lib/api";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import { ToastProvider } from "@/lib/toast";
import type { Settings } from "@/lib/types";
import { SettingsView } from "./SettingsView";

// It reads the theme off `<html>`, which the hand-made DOM does not have; nothing here is about it.
vi.mock("./AppearanceSection", () => ({ AppearanceSection: () => null }));

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

const settings = (allowlist: string[]): Settings => ({ allowlist }) as unknown as Settings;

async function show(client: Partial<ApiClient>, initial: Settings) {
  const tree = await renderTree(
    createElement(ToastProvider, null, createElement(SettingsView, { settings: initial, engines: [], client: client as ApiClient, onClose: () => undefined })),
  );
  trees.push(tree);
  return tree;
}

const removeButtons = (tree: Tree) => tree.all((node) => node.getAttribute("aria-label")?.startsWith("移除 ") === true);

describe("设置 → 一直允许", () => {
  it("takes one entry off with the server's own edit, never by writing back this page's copy of the list", async () => {
    const client = {
      putSettings: vi.fn(async () => settings([])),
      // Another window's card added `bash(ls)` after this page read the list.
      disallowTool: vi.fn(async () => settings(["read", "bash(ls)"])),
    };
    const tree = await show(client, settings(["read", "write"]));
    const remove = removeButtons(tree).find((node) => node.getAttribute("aria-label") === "移除 write");
    expect(remove).toBeDefined();
    await tree.click(remove!);

    expect(client.disallowTool).toHaveBeenCalledTimes(1);
    expect(client.disallowTool).toHaveBeenCalledWith("write");
    expect(client.putSettings).not.toHaveBeenCalled();
    // The list shown is the server's answer: the entry added meanwhile stays.
    expect(removeButtons(tree).map((node) => node.getAttribute("aria-label"))).toEqual(["移除 read", "移除 bash(ls)"]);
  });

  it("keeps the entry and says why when the server refuses", async () => {
    const client = { putSettings: vi.fn(), disallowTool: vi.fn(async () => Promise.reject(new Error("设置写不进去"))) };
    const tree = await show(client, settings(["write"]));
    await tree.click(removeButtons(tree)[0]!);
    expect(tree.text()).toContain("设置写不进去");
    expect(removeButtons(tree).map((node) => node.getAttribute("aria-label"))).toEqual(["移除 write"]);
  });
});
