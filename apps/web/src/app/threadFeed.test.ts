import { useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { renderHook, type HookHandle } from "@/lib/testing/renderHook";
import type { QueueItem } from "@/features/worklog/queue";
import { ThreadFeed, tabReadsMessages } from "./threadFeed";

const message = (id: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: id }] });
const item = (kind: QueueItem["kind"], anchor: string): QueueItem => ({ kind, anchor, label: anchor, mono: kind === "approval" });

const handles: Array<HookHandle<unknown, unknown>> = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.unmount();
});

describe("ThreadFeed", () => {
  it("holds the latest messages and tells subscribers, but not about the same array twice", () => {
    const feed = new ThreadFeed();
    let told = 0;
    const off = feed.subscribe(() => (told += 1));
    const first = [message("a")];
    feed.setMessages(first);
    feed.setMessages(first);
    expect(feed.getMessages()).toBe(first);
    expect(told).toBe(1);
    off();
    feed.setMessages([message("b")]);
    expect(told).toBe(1);
  });

  it("does not stir for a queue that came out the same: it is rebuilt from the messages on every chunk", () => {
    const feed = new ThreadFeed();
    let told = 0;
    feed.subscribe(() => (told += 1));
    feed.setQueue([item("approval", "a1"), item("question", "q1")]);
    const held = feed.getQueue();
    feed.setQueue([item("approval", "a1"), item("question", "q1")]);
    expect(feed.getQueue()).toBe(held);
    expect(told).toBe(1);
    feed.setQueue([item("approval", "a1")]);
    expect(told).toBe(2);
  });

  it("counts the questions in the queue, for the toggle's badge", () => {
    const feed = new ThreadFeed();
    feed.setQueue([item("approval", "a1"), item("question", "q1"), item("question", "q2")]);
    expect(feed.getQuestions()).toBe(2);
    feed.setQueue([]);
    expect(feed.getQuestions()).toBe(0);
  });

  it("renders a subscriber to the question count only when the count changes, however the messages stream", async () => {
    const feed = new ThreadFeed();
    let renders = 0;
    const hook = await renderHook(() => {
      renders += 1;
      return useSyncExternalStore(feed.subscribe, feed.getQuestions);
    });
    handles.push(hook as unknown as HookHandle<unknown, unknown>);
    const before = renders;

    for (let chunk = 0; chunk < 20; chunk++) {
      await hook.act(() => {
        feed.setMessages([message(`m${chunk}`)]);
        feed.setQueue([item("approval", "a1")]);
      });
    }
    expect(renders).toBe(before);

    await hook.act(() => feed.setQueue([item("approval", "a1"), item("question", "q1")]));
    expect(hook.result.current).toBe(1);
    expect(renders).toBe(before + 1);
  });

  it("renders a subscriber to the messages on every change", async () => {
    const feed = new ThreadFeed();
    const hook = await renderHook(() => useSyncExternalStore(feed.subscribe, feed.getMessages));
    handles.push(hook as unknown as HookHandle<unknown, unknown>);
    await hook.act(() => feed.setMessages([message("a")]));
    expect(hook.result.current.map((entry) => entry.id)).toEqual(["a"]);
    await hook.act(() => feed.setMessages([message("a"), message("b")]));
    expect(hook.result.current).toHaveLength(2);
  });
});

describe("tabReadsMessages", () => {
  it("is false for the tabs that never show them, true for those that do", () => {
    for (const tab of ["home", "queue", "changes", "files"] as const) expect(tabReadsMessages(tab)).toBe(false);
    for (const tab of ["term", "plan", "tool"] as const) expect(tabReadsMessages(tab)).toBe(true);
  });
});
