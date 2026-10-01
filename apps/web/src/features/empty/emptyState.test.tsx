import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import { WORKSPACES, WorkspaceItems } from "./EmptyState";

const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
});

describe("运行位置's menu", () => {
  const html = (workspace: "project" | "worktree" = "project") => renderToStaticMarkup(createElement(WorkspaceItems, { workspace, onPick: () => undefined }));

  it("lists the two places under the small title", () => {
    const markup = html();
    expect(markup).toContain("运行位置");
    expect(markup).toContain("本机 · 主目录");
    expect(markup).toContain("本机 · worktree");
    expect(WORKSPACES.map((entry) => entry.id)).toEqual(["project", "worktree"]);
  });

  it("says out loud, in the picker, what a worktree does not bring along (product.md: 选择器里要明说)", () => {
    const markup = html();
    expect(markup).toContain("从已提交的 HEAD 开出，不带你未提交的改动");
    expect(markup).toContain("直接改你手上的文件");
  });

  it("ticks the place in force", () => {
    expect(html("project").match(/✓/g)).toHaveLength(1);
    const [first, second] = html("worktree").split("<button").slice(1);
    expect(first).not.toContain("✓");
    expect(second).toContain("✓");
  });

  it("picks the row that is pressed", async () => {
    const onPick = vi.fn();
    const tree = await renderTree(createElement(WorkspaceItems, { workspace: "project", onPick }));
    trees.push(tree);
    await tree.click(tree.byText("本机 · worktree"));
    expect(onPick).toHaveBeenCalledWith("worktree");
  });
});
