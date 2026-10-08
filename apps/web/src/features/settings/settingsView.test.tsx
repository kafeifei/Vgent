import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@/lib/api";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import { ToastProvider } from "@/lib/toast";
import type { Settings } from "@/lib/types";
import { SettingsView, type SettingsTab } from "./SettingsView";

// It reads the theme off `<html>`, which the hand-made DOM does not have; nothing here is about it.
vi.mock("./AppearanceSection", () => ({ AppearanceSection: () => null }));

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

const settings = (allowlist: string[]): Settings => ({ allowlist }) as unknown as Settings;

async function show(client: Partial<ApiClient>, initial: Settings, initialTab: SettingsTab = "general") {
  const tree = await renderTree(
    createElement(ToastProvider, null, createElement(SettingsView, { initialTab, settings: initial, engines: [], client: client as ApiClient, onClose: () => undefined })),
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


it("shows all managed components in 下载与更新 and submits a manual install", async () => {
  const runtime = { engine: "opencode" as const, label: "OpenCode", package: "opencode-ai", updateAvailable: false, unverified: false, bad: [], busy: false, working: false, broken: false };
  const client: Partial<ApiClient> = {
    runtimeEnvironment: async () => ({ desktop: true, version: "0.2.224", nodeVersion: "22.23.2", pnpmVersion: "10.33.2", managedInstaller: true, releasesUrl: "https://github.com/kafeifei/Vgent/releases" }),
    nativeCodexStatus: async () => ({ available: true, phase: "ready", version: "0.156.1", downloaded: 0, total: 100 }),
    checkApplicationUpdate: async () => ({ version: "0.2.225", downloadUrl: "https://github.com/kafeifei/Vgent/releases/download/v0.2.225/Vgent-0.2.225-mac-arm64.zip", updateAvailable: true, prerelease: false }),
    checkRuntimes: async () => [runtime],
    listRuntimes: async () => [runtime],
    installRuntime: vi.fn(async () => ({ accepted: true })),
  };
  const tree = await show(client, settings([]), "downloads");
  expect(tree.text()).toContain("工作台环境");
  expect(tree.text()).toContain("pnpm 10.33.2");
  expect(tree.text()).toContain("OpenCode");
  expect(tree.text()).toContain("0.156.1");
  expect(tree.text()).toContain("下载 0.2.225");
  const install = tree.all(node => node.tagName === "BUTTON" && node.textContent === "立即安装")[0];
  expect(install).toBeDefined();
  await tree.click(install!);
  expect(client.installRuntime).toHaveBeenCalledWith("opencode");
});
