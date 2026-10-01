import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@/lib/api";
import { renderHook, type HookHandle } from "@/lib/testing/renderHook";
import type { ChangesResponse, ChangesScope, IntegrationStatus } from "@/lib/types";
import { useChanges, useTaskState, type ChangesView } from "./useChanges";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const snapshotOf = (branch: string, ...paths: string[]): ChangesResponse =>
  ({ repoPath: `/repo/${branch}`, branch, files: paths.map((path) => ({ path, status: "modified", additions: 3, deletions: 1 })) }) as unknown as ChangesResponse;

const integrationOf = (commitsAhead: number): IntegrationStatus => ({ commitsAhead }) as unknown as IntegrationStatus;

interface Props {
  threadId: string | null;
  refreshKey: string;
}

type Client = Pick<ApiClient, "listChanges" | "getIntegration" | "getFileDiff" | "revertFile" | "integrate">;

/** Stable, like the workbench's own `selectChange` and `toast`. */
const noop = (): void => {};

const handles: Array<HookHandle<unknown, unknown>> = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.unmount();
});

/** The hook under a client the test steers; `renders` records what every single render saw. */
async function mount(client: Partial<Client>, initial: Props) {
  const renders: Array<{ threadId: string | null; view: ChangesView }> = [];
  const hook = await renderHook(
    (props: Props) => {
      const view = useChanges({
        client: client as ApiClient,
        threadId: props.threadId,
        refreshKey: props.refreshKey,
        selected: null,
        onSelect: noop,
        toast: noop,
      });
      renders.push({ threadId: props.threadId, view });
      return view;
    },
    { props: initial },
  );
  handles.push(hook as HookHandle<unknown, unknown>);
  return { hook, renders };
}

describe("useChanges when the task changes", () => {
  it("never shows the last task's changes, branch or action bar under the next one", async () => {
    const slow = deferred<ChangesResponse>();
    const slowIntegration = deferred<IntegrationStatus>();
    const client: Partial<Client> = {
      listChanges: vi.fn((threadId: string) => (threadId === "a" ? Promise.resolve(snapshotOf("feature/a", "a.ts")) : slow.promise)),
      getIntegration: vi.fn((threadId: string) => (threadId === "a" ? Promise.resolve(integrationOf(2)) : slowIntegration.promise)),
    };
    const { hook, renders } = await mount(client, { threadId: "a", refreshKey: "1" });
    expect(hook.result.current.snapshot?.branch).toBe("feature/a");
    expect(hook.result.current.integration?.commitsAhead).toBe(2);

    await hook.rerender({ threadId: "b", refreshKey: "1" });
    // b's answer has not arrived: a's numbers must not stand in for it.
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.integration).toBeNull();
    expect(hook.result.current.loading).toBe(true);
    // Nor did any render of b, including the very first, show a's.
    const ofB = renders.filter((entry) => entry.threadId === "b");
    expect(ofB.length).toBeGreaterThan(0);
    expect(ofB.every((entry) => entry.view.snapshot == null && entry.view.integration == null)).toBe(true);

    await hook.act(() => {
      slow.resolve(snapshotOf("feature/b", "b.ts", "c.ts"));
      slowIntegration.resolve(integrationOf(0));
    });
    expect(hook.result.current.snapshot?.branch).toBe("feature/b");
    expect(hook.result.current.snapshot?.files).toHaveLength(2);
    expect(hook.result.current.integration?.commitsAhead).toBe(0);
  });

  it("does not carry the last task's error over either", async () => {
    const slow = deferred<ChangesResponse>();
    const client: Partial<Client> = {
      listChanges: vi.fn((threadId: string) => (threadId === "a" ? Promise.reject(new Error("不是 git 仓库")) : slow.promise)),
      getIntegration: vi.fn(() => Promise.reject(new Error("no"))),
    };
    const { hook, renders } = await mount(client, { threadId: "a", refreshKey: "1" });
    expect(hook.result.current.error).toBe("不是 git 仓库");

    await hook.rerender({ threadId: "b", refreshKey: "1" });
    expect(hook.result.current.error).toBeNull();
    expect(renders.filter((entry) => entry.threadId === "b").every((entry) => entry.view.error == null)).toBe(true);
    slow.resolve(snapshotOf("main"));
  });

  it("drops the snapshot when there is no task at all", async () => {
    const client: Partial<Client> = {
      listChanges: vi.fn(() => Promise.resolve(snapshotOf("main", "a.ts"))),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
    };
    const { hook } = await mount(client, { threadId: "a", refreshKey: "1" });
    expect(hook.result.current.snapshot).not.toBeNull();
    await hook.rerender({ threadId: null, refreshKey: "" });
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.integration).toBeNull();
  });

  it("ignores an answer that comes back for the task the reader has left", async () => {
    const late = deferred<ChangesResponse>();
    const client: Partial<Client> = {
      listChanges: vi.fn((threadId: string) => (threadId === "a" ? late.promise : Promise.resolve(snapshotOf("feature/b", "b.ts")))),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
    };
    const { hook } = await mount(client, { threadId: "a", refreshKey: "1" });
    await hook.rerender({ threadId: "b", refreshKey: "1" });
    expect(hook.result.current.snapshot?.branch).toBe("feature/b");

    await hook.act(() => late.resolve(snapshotOf("feature/a", "a.ts")));
    expect(hook.result.current.snapshot?.branch).toBe("feature/b");
  });

  it("starts every task on 全部改动: the last one's 「上一轮」 is not asked of the next", async () => {
    const asked: Array<[string, ChangesScope]> = [];
    const client: Partial<Client> = {
      listChanges: vi.fn((threadId: string, scope: ChangesScope = "all") => {
        asked.push([threadId, scope]);
        return Promise.resolve({ ...snapshotOf("main", "a.ts"), lastTurn: true } as ChangesResponse);
      }),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
    };
    const { hook } = await mount(client, { threadId: "a", refreshKey: "1" });
    expect(hook.result.current.lastTurn).toBe(true);
    await hook.act(() => hook.result.current.setScope("last-turn"));
    expect(hook.result.current.scope).toBe("last-turn");

    await hook.rerender({ threadId: "b", refreshKey: "1" });
    expect(hook.result.current.scope).toBe("all");
    expect(asked.filter(([threadId]) => threadId === "b").map(([, scope]) => scope)).toEqual(["all"]);
    // b's own answer says whether it has a last turn; until then it has none.
    expect(hook.result.current.lastTurn).toBe(true);
  });

  it("does not bring back a task's failed 带回主目录, its conflicts or its 「上一轮」 when it is come back to", async () => {
    const conflicts = [{ path: "a.ts", resolution: "skipped", reason: "两边都改了" }];
    const client: Partial<Client> = {
      listChanges: vi.fn(() => Promise.resolve({ ...snapshotOf("main", "a.ts"), lastTurn: true } as ChangesResponse)),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
      integrate: vi.fn(() => Promise.reject(new ApiError("主目录里有冲突", 409, "apply_conflict", { conflicts }))),
    };
    const { hook, renders } = await mount(client, { threadId: "a", refreshKey: "1" });
    await hook.act(() => hook.result.current.setScope("last-turn"));
    await hook.act(() => hook.result.current.integrate("apply"));
    await vi.waitFor(() => expect(hook.result.current.applyConflicts).toEqual(conflicts));
    expect(hook.result.current.actionError).toBe("主目录里有冲突");

    await hook.rerender({ threadId: "b", refreshKey: "1" });
    const back = renders.length;
    await hook.rerender({ threadId: "a", refreshKey: "1" });
    // Not in any render of the return, the first included.
    for (const { view } of renders.slice(back)) {
      expect(view.actionError).toBeNull();
      expect(view.applyConflicts).toBeNull();
      expect(view.scope).toBe("all");
    }
  });

  it("clears what the last action on a task said", async () => {
    const client: Partial<Client> = {
      listChanges: vi.fn(() => Promise.resolve(snapshotOf("main", "a.ts"))),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
      integrate: vi.fn(() => Promise.reject(new Error("提交失败：没有配置 user.name"))),
    };
    const { hook, renders } = await mount(client, { threadId: "a", refreshKey: "1" });
    await hook.act(() => hook.result.current.integrate("commit", { message: "x" }));
    await vi.waitFor(() => expect(hook.result.current.actionError).toBe("提交失败：没有配置 user.name"));

    await hook.rerender({ threadId: "b", refreshKey: "1" });
    expect(renders.filter((entry) => entry.threadId === "b").every((entry) => entry.view.actionError == null)).toBe(true);
  });
});

describe("useChanges when nothing changes", () => {
  it("hands back the same view object on a render that changed nothing, so what is memoised on it stays put", async () => {
    const client: Partial<Client> = {
      listChanges: vi.fn(() => Promise.resolve(snapshotOf("main", "a.ts"))),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
    };
    const { hook } = await mount(client, { threadId: "a", refreshKey: "1" });
    const first = hook.result.current;
    await hook.rerender({ threadId: "a", refreshKey: "1" });
    expect(hook.result.current).toBe(first);
  });

  it("loads again when the task's updatedAt moves, and a fresh snapshot replaces the old one", async () => {
    let call = 0;
    const client: Partial<Client> = {
      listChanges: vi.fn(() => Promise.resolve(snapshotOf(`main-${++call}`, "a.ts"))),
      getIntegration: vi.fn(() => Promise.resolve(integrationOf(0))),
    };
    const { hook } = await mount(client, { threadId: "a", refreshKey: "1" });
    const before = hook.result.current.snapshot;
    await hook.rerender({ threadId: "a", refreshKey: "2" });
    expect(hook.result.current.snapshot).not.toBe(before);
    expect(hook.result.current.snapshot?.branch).toBe("main-2");
  });
});

describe("useTaskState", () => {
  it("reads as the empty value under any other task, and again when the first one is come back to", async () => {
    const hook = await renderHook((id: string) => useTaskState<string | null>(id, null), { props: "a" });
    handles.push(hook as unknown as HookHandle<unknown, unknown>);
    await hook.act(() => hook.result.current[1]("a 写的"));
    expect(hook.result.current[0]).toBe("a 写的");
    await hook.rerender("b");
    expect(hook.result.current[0]).toBeNull();
    // A visit starts clean: what the last visit to a said is not brought back.
    await hook.rerender("a");
    expect(hook.result.current[0]).toBeNull();
    await hook.act(() => hook.result.current[1]("a 又写的"));
    expect(hook.result.current[0]).toBe("a 又写的");
  });

  it("does not let a late write from the task that was left take the slot of the one on screen", async () => {
    const hook = await renderHook((id: string) => useTaskState<string | null>(id, null), { props: "a" });
    handles.push(hook as unknown as HookHandle<unknown, unknown>);
    // What an action still in flight under a holds on to.
    const lateWriteOfA = hook.result.current[1];
    await hook.rerender("b");
    await hook.act(() => hook.result.current[1]("b 写的"));
    await hook.act(() => lateWriteOfA("a 迟到的"));
    expect(hook.result.current[0]).toBe("b 写的");
  });
});
