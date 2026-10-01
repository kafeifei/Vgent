import { afterEach, describe, expect, it } from "vitest";
import { renderHook, type HookHandle } from "@/lib/testing/renderHook";
import type { FileEntry } from "@/lib/types";
import { EXPAND_ALL_MAX, initialExpansion, useTreeExpansion } from "./treeExpansion";

const dir = (path: string): FileEntry => ({ path, kind: "dir" }) as FileEntry;
const file = (path: string): FileEntry => ({ path, kind: "file" }) as FileEntry;

/** A small tree (`src`, `docs`) and the same tree after the task wrote a file into each. */
const small = [dir("docs"), file("docs/a.md"), dir("src"), file("src/a.ts")];
const smallLater = [...small, file("docs/b.md"), file("src/b.ts"), dir("src/lib"), file("src/lib/c.ts")];
/** More entries than `EXPAND_ALL_MAX`: opens closed. */
const big = [dir("a"), dir("b"), ...Array.from({ length: EXPAND_ALL_MAX }, (_, index) => file(`a/f${index}.ts`))];

const handles: Array<HookHandle<unknown, unknown>> = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.unmount();
});

async function mount(threadId: string | null) {
  const hook = await renderHook((id: string | null) => useTreeExpansion(id), { props: threadId });
  handles.push(hook as HookHandle<unknown, unknown>);
  return hook;
}

describe("initialExpansion", () => {
  it("opens every folder of a small listing and none of a large one", () => {
    expect([...initialExpansion(small)].sort()).toEqual(["docs", "src"]);
    expect(big.length).toBeGreaterThan(EXPAND_ALL_MAX);
    expect(initialExpansion(big).size).toBe(0);
  });
});

describe("useTreeExpansion", () => {
  it("starts from the task's first listing", async () => {
    const hook = await mount("t1");
    expect(hook.result.current.expanded.size).toBe(0);
    await hook.act(() => hook.result.current.settle(small));
    expect([...hook.result.current.expanded].sort()).toEqual(["docs", "src"]);
  });

  it("leaves the folders where the reader put them when the task writes and the listing is fetched again", async () => {
    const hook = await mount("t1");
    await hook.act(() => hook.result.current.settle(small));
    // The reader closes `docs` and goes on reading.
    await hook.act(() => hook.result.current.toggle("docs"));
    expect([...hook.result.current.expanded]).toEqual(["src"]);

    // The task writes; the listing arrives again, and again after that.
    await hook.act(() => hook.result.current.settle(smallLater));
    await hook.act(() => hook.result.current.settle(smallLater));
    expect([...hook.result.current.expanded]).toEqual(["src"]);

    // A folder the reader opened by hand stays open through it too.
    await hook.act(() => hook.result.current.toggle("src/lib"));
    await hook.act(() => hook.result.current.settle(smallLater));
    expect([...hook.result.current.expanded].sort()).toEqual(["src", "src/lib"]);
  });

  it("does not open a large tree by itself when it grows, nor close what was opened in it", async () => {
    const hook = await mount("t1");
    await hook.act(() => hook.result.current.settle(big));
    await hook.act(() => hook.result.current.toggle("a"));
    await hook.act(() => hook.result.current.settle([...big, file("b/new.ts")]));
    expect([...hook.result.current.expanded]).toEqual(["a"]);
  });

  it("gives another task an empty tree at once and its own first listing, then leaves that one alone too", async () => {
    const seen: string[][] = [];
    const hook = await renderHook((id: string | null) => {
      const tree = useTreeExpansion(id);
      seen.push([id ?? "-", ...[...tree.expanded].sort()]);
      return tree;
    }, { props: "t1" as string | null });
    handles.push(hook as HookHandle<unknown, unknown>);
    await hook.act(() => hook.result.current.settle(small));
    await hook.act(() => hook.result.current.toggle("src"));

    await hook.rerender("t2");
    // Not a single render of t2 saw t1's folders.
    expect(seen.filter(([id]) => id === "t2").every((entry) => entry.length === 1)).toBe(true);
    await hook.act(() => hook.result.current.settle(small));
    expect([...hook.result.current.expanded].sort()).toEqual(["docs", "src"]);
    await hook.act(() => hook.result.current.toggle("docs"));

    // Back to the first task: it starts over from its own first listing, not from t2's.
    await hook.rerender("t1");
    await hook.act(() => hook.result.current.settle(small));
    expect([...hook.result.current.expanded].sort()).toEqual(["docs", "src"]);
  });

  it("ignores a listing that arrives for the task the reader has already left", async () => {
    const hook = await mount("t1");
    const late = hook.result.current.settle;
    await hook.rerender("t2");
    await hook.act(() => late(small));
    expect(hook.result.current.expanded.size).toBe(0);
  });
});
