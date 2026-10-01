import { describe, expect, it, vi } from "vitest";
import { deleteTask, type DeletionEffects } from "./deleteTask";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function effects(selected: () => string | null): DeletionEffects & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    forgetChat: (id) => void log.push(`chat ${id}`),
    forgetCreated: (id) => void log.push(`created ${id}`),
    selected,
    deselect: () => void log.push("deselect"),
    toast: (message) => void log.push(`toast ${message}`),
  };
}

describe("deleteTask", () => {
  it("returns to the empty state when the deleted task is the one still on screen", async () => {
    const fx = effects(() => "t1");
    await deleteTask("t1", () => Promise.resolve(), fx);
    expect(fx.log).toEqual(["chat t1", "created t1", "deselect", "toast 已删除任务"]);
  });

  it("leaves the reader on the task they opened while the delete was in flight", async () => {
    // 删除 was clicked on t1 while it was open; the request is slow, and by the
    // time it answers the reader is on t2.
    let selected: string | null = "t1";
    const request = deferred();
    const fx = effects(() => selected);
    const done = deleteTask("t1", () => request.promise, fx);
    selected = "t2";
    request.resolve();
    await done;
    expect(fx.log).toEqual(["chat t1", "created t1", "toast 已删除任务"]);
  });

  it("does not deselect a task the reader came to while a delete of another was in flight", async () => {
    let selected: string | null = null;
    const request = deferred();
    const fx = effects(() => selected);
    const done = deleteTask("t1", () => request.promise, fx);
    selected = "t1";
    request.resolve();
    await done;
    // Now it IS the one on screen, and it is gone: back to the empty state.
    expect(fx.log).toContain("deselect");
  });

  it("changes nothing but the toast when the server refuses", async () => {
    const fx = effects(() => "t1");
    await deleteTask("t1", () => Promise.reject(new Error("任务正在归档，稍等")), fx);
    expect(fx.log).toEqual(["toast 任务正在归档，稍等"]);
  });

  it("asks which task is on screen only after the server has answered", async () => {
    const selected = vi.fn(() => "t1");
    const request = deferred();
    const done = deleteTask("t1", () => request.promise, effects(selected));
    await Promise.resolve();
    expect(selected).not.toHaveBeenCalled();
    request.resolve();
    await done;
    expect(selected).toHaveBeenCalledTimes(1);
  });
});
