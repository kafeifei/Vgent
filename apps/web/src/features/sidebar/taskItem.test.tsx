import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shortTime } from "@/lib/format";
import { renderTree, type Tree } from "@/lib/testing/renderTree";
import type { ThreadSummary } from "@/lib/types";
import { RowMenuItems, TaskItem } from "./TaskItem";

// A spy on the one formatter every row render calls, to count renders.
vi.mock("@/lib/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/format")>();
  return { ...actual, shortTime: vi.fn(actual.shortTime) };
});


const trees: Tree[] = [];
afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.unmount();
  vi.mocked(shortTime).mockClear();
});

async function show(element: Parameters<typeof renderTree>[0]) {
  const tree = await renderTree(element);
  trees.push(tree);
  return tree;
}

/** Lets the promises a click started (the uncommitted count) come back and be committed. */
const settle = (tree: Tree) => tree.act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const thread = (extra: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    version: 1,
    id: "t1",
    projectId: "p1",
    title: "任务一",
    engine: "claude-code",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    pendingApprovals: 0,
    ...extra,
  }) as ThreadSummary;

describe("the row's menu", () => {
  function menu(extra: Partial<Parameters<typeof RowMenuItems>[0]> = {}) {
    const calls = { close: vi.fn(), archive: vi.fn(), confirmArchive: vi.fn(), delete: vi.fn(), unread: vi.fn(), rename: vi.fn(), count: vi.fn(async () => 0) };
    const props = {
      archived: false,
      unread: false,
      live: false,
      transition: undefined,
      worktree: false,
      close: calls.close,
      onArchive: calls.archive,
      onCheckUncommitted: calls.count,
      onUnread: calls.unread,
      onDelete: calls.delete,
      onStartRename: calls.rename,
      onConfirmArchive: calls.confirmArchive,
      ...extra,
    };
    return { calls, element: createElement(RowMenuItems, props) };
  }

  it("lists 重命名, 标为未读, 归档 and 删除任务… and nothing else", async () => {
    const tree = await show(menu().element);
    expect(tree.byRole("menuitem").map((row) => row.textContent)).toEqual(["重命名R", "标为未读U", "归档A", "删除任务…D"]);
  });

  it("does not list 归档 while a turn is live — no dead row, no 「进行中」, no reason", async () => {
    const tree = await show(menu({ live: true }).element);
    expect(tree.byRole("menuitem").map((row) => row.textContent)).toEqual(["重命名R", "标为未读U", "删除任务…D"]);
    expect(tree.text()).not.toContain("进行中");
    expect(tree.text()).not.toContain("任务还在进行中");
    expect(tree.all((node) => node.getAttribute("title") != null)).toEqual([]);
  });

  it("does not list 归档 while the worktree is being moved either, and does not repeat the row's own 「归档中」", async () => {
    const tree = await show(menu({ transition: "archiving" }).element);
    expect(tree.text()).not.toContain("归档");
    const restoring = await show(menu({ archived: true, transition: "unarchiving" }).element);
    expect(restoring.text()).not.toContain("归档");
    expect(restoring.text()).not.toContain("恢复中");
  });

  it("offers 取消归档 on an archived task", async () => {
    const tree = await show(menu({ archived: true }).element);
    expect(tree.text()).toContain("取消归档");
  });

  it("archives a clean worktree straight away, and a plain task without asking", async () => {
    const worktree = menu({ worktree: true });
    const tree = await show(worktree.element);
    await tree.click(tree.byText("归档"));
    await settle(tree);
    expect(worktree.calls.count).toHaveBeenCalledTimes(1);
    expect(worktree.calls.archive).toHaveBeenCalledWith(true, false);
    expect(worktree.calls.close).toHaveBeenCalledTimes(1);

    const plain = menu();
    const other = await show(plain.element);
    await other.click(other.byText("归档"));
    expect(plain.calls.count).not.toHaveBeenCalled();
    expect(plain.calls.archive).toHaveBeenCalledWith(true);
  });

  it("hands a worktree with uncommitted changes to the dialog outside the menu, and archives nothing itself", async () => {
    const dirty = menu({ worktree: true });
    dirty.calls.count.mockResolvedValue(2);
    const tree = await show(dirty.element);
    await tree.click(tree.byText("归档"));
    await settle(tree);
    expect(dirty.calls.confirmArchive).toHaveBeenCalledWith(2);
    expect(dirty.calls.close).toHaveBeenCalledTimes(1);
    expect(dirty.calls.archive).not.toHaveBeenCalled();
  });

  describe("删除任务", () => {
    it("asks first, for a task with no worktree without counting anything, and deletes on confirm", async () => {
      const { calls, element } = menu();
      const tree = await show(element);
      await tree.click(tree.byText("删除任务…"));
      expect(calls.count).not.toHaveBeenCalled();
      expect(tree.text()).toContain("删除这个任务？");
      expect(tree.text()).toContain("会删掉对话记录、worktree 和快照。分支上如果有提交会保留下来。");
      expect(tree.text()).not.toContain("没提交");
      expect(calls.delete).not.toHaveBeenCalled();

      await tree.click(tree.byText("确认删除"));
      expect(calls.delete).toHaveBeenCalledTimes(1);
      expect(calls.close).toHaveBeenCalledTimes(1);
    });

    it("says how many files' changes are lost when the worktree has uncommitted ones", async () => {
      const { calls, element } = menu({ worktree: true });
      calls.count.mockResolvedValue(3);
      const tree = await show(element);
      await tree.click(tree.byText("删除任务…"));
      await settle(tree);

      expect(calls.count).toHaveBeenCalledTimes(1);
      expect(tree.text()).toContain("3 个文件的改动没提交，会随 worktree 一起丢失。");
      expect(tree.text()).toContain("删除这个任务？");
      // Asking is not deleting.
      expect(calls.delete).not.toHaveBeenCalled();

      await tree.click(tree.byText("取消"));
      expect(tree.text()).toContain("重命名");
      expect(tree.text()).not.toContain("没提交");
      expect(calls.delete).not.toHaveBeenCalled();
    });

    it("waits for the count before it shows the step: the row is dead while it is being asked", async () => {
      let answer!: (files: number) => void;
      const { calls, element } = menu({ worktree: true });
      calls.count.mockImplementation(() => new Promise<number>((resolve) => (answer = resolve)));
      const tree = await show(element);
      await tree.click(tree.byText("删除任务…"));
      expect(tree.text()).not.toContain("删除这个任务？");
      expect(tree.byRole("menuitem", /删除任务/)[0]?.props.disabled).toBe(true);

      await tree.act(() => answer(2));
      expect(tree.text()).toContain("2 个文件的改动没提交");
    });

    it("says so when the count could not be read, instead of taking it for none", async () => {
      const { calls, element } = menu({ worktree: true });
      calls.count.mockRejectedValue(new Error("任务正在归档，稍等"));
      const tree = await show(element);
      await tree.click(tree.byText("删除任务…"));
      await settle(tree);
      expect(tree.text()).toContain("没能确认有没有没提交的改动，删除后无法找回。");
      expect(calls.delete).not.toHaveBeenCalled();
    });

    it("adds nothing to the step for a worktree that has no uncommitted work", async () => {
      const { calls, element } = menu({ worktree: true });
      calls.count.mockResolvedValue(0);
      const tree = await show(element);
      await tree.click(tree.byText("删除任务…"));
      await settle(tree);
      expect(tree.text()).toContain("删除这个任务？");
      expect(tree.text()).not.toContain("没提交");
      expect(tree.text()).not.toContain("没能确认");
    });

    it("counts again each time the menu is opened, and a closed menu deletes nothing", async () => {
      const { calls, element } = menu({ worktree: true });
      calls.count.mockResolvedValue(1);
      const first = await show(element);
      await first.click(first.byText("删除任务…"));
      await settle(first);
      await first.unmount();
      expect(calls.delete).not.toHaveBeenCalled();

      calls.count.mockResolvedValue(4);
      const second = await show(element);
      await second.click(second.byText("删除任务…"));
      await settle(second);
      expect(calls.count).toHaveBeenCalledTimes(2);
      expect(second.text()).toContain("4 个文件的改动没提交");
    });
  });
});

describe("a task row", () => {
  const handlers = () => ({
    onSelect: vi.fn(),
    onArchive: vi.fn(),
    onCheckUncommitted: vi.fn(async () => 0),
    onUnread: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
  });

  it("hands its own id to whichever function it is given, so one function serves every row", async () => {
    const given = handlers();
    const tree = await show(createElement(TaskItem, { thread: thread({ id: "abc" }), selected: false, ...given }));
    await tree.click(tree.byText("任务一"));
    expect(given.onSelect).toHaveBeenCalledWith("abc");
  });

  describe("memoisation", () => {
    const item = thread();
    const given = handlers();
    const row = (extra: Record<string, unknown> = {}) => createElement(TaskItem, { thread: item, selected: false, ...given, ...extra });
    const renders = () => vi.mocked(shortTime).mock.calls.length;
    // The stamp also renders when the minute turns; a held clock keeps that out of the counts.
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(async () => {
      // Unmounted while the clock is still held, so the minute timer is let go on the clock that armed it.
      for (const tree of trees.splice(0)) await tree.unmount();
      vi.useRealTimers();
    });

    it("is not rendered again while what it is given is the same", async () => {
      const tree = await show(row());
      const rendered = renders();
      expect(rendered).toBeGreaterThan(0);
      // The list around it renders (another task changed): same task object, same functions.
      for (let times = 0; times < 5; times++) await tree.rerender(row());
      expect(renders()).toBe(rendered);
    });

    it("is rendered again when its task, its selection or one of its functions changes", async () => {
      const tree = await show(row());
      let rendered = renders();
      const renamed = thread({ title: "改了名" });

      await tree.rerender(row({ selected: true }));
      expect(renders()).toBe(++rendered);
      await tree.rerender(row({ selected: true, thread: renamed }));
      expect(renders()).toBe(++rendered);
      expect(tree.text()).toContain("改了名");
      // A function made afresh on every render is what would defeat all of this.
      await tree.rerender(row({ selected: true, thread: renamed, onSelect: () => undefined }));
      expect(renders()).toBe(++rendered);
    });

    it("still moves its stamp on as the minutes pass, with nothing it is given changing", async () => {
      vi.setSystemTime(Date.parse("2026-09-18T11:58:10.000Z"));
      const fresh = thread({ updatedAt: "2026-09-18T11:58:00.000Z" });
      const tree = await show(row({ thread: fresh }));
      expect(tree.all((node) => node.ownText === "now")).toHaveLength(1);

      // An idle window: no snapshot, no rerender of the list — only the clock.
      await tree.act(() => {
        vi.advanceTimersByTime(3 * 60_000);
      });
      expect(tree.all((node) => node.ownText === "now")).toHaveLength(0);
      expect(tree.all((node) => node.ownText === "3m")).toHaveLength(1);
    });
  });
});
