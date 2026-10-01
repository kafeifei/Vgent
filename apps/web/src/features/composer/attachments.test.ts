import { describe, expect, it, vi } from "vitest";
import { formatBytes, ingestFiles, isImage, partitionBySize, toFileParts, type Attachment } from "./attachments";

describe("attachments", () => {
  it("formats sizes the way a tile shows them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });

  it("keeps what fits and names what does not", () => {
    const files = [
      { name: "a.png", size: 10 },
      { name: "huge.mov", size: 99 },
    ];
    expect(partitionBySize(files, 50)).toEqual({ accepted: [files[0]], rejected: ["huge.mov"] });
  });

  it("turns attachments into file parts", () => {
    expect(toFileParts([{ id: "1", name: "a.png", mediaType: "image/png", url: "data:image/png;base64,AA", size: 1 }])).toEqual([
      { type: "file", mediaType: "image/png", filename: "a.png", url: "data:image/png;base64,AA" },
    ]);
    expect(isImage("image/webp")).toBe(true);
    expect(isImage("application/pdf")).toBe(false);
  });
});

describe("ingestFiles", () => {
  const tile = (id: string): Attachment => ({ id, name: `${id}.png`, mediaType: "image/png", url: "data:image/png;base64,AA", size: 1 });
  const file = (name: string) => ({ name }) as File;

  /** The list a view keeps, changed by function the way `useDraft`'s `setAttachments` does. */
  function list(initial: Attachment[] = []) {
    const state = { current: initial };
    return { state, update: (change: (current: Attachment[]) => Attachment[]) => void (state.current = change(state.current)) };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("keeps both files when two drops are being read at the same time and finish one after the other", async () => {
    const first = deferred<{ attachments: Attachment[]; rejected: string[] }>();
    const second = deferred<{ attachments: Attachment[]; rejected: string[] }>();
    const reads = [first, second];
    const read = vi.fn(() => (reads.shift() as typeof first).promise);
    const { state, update } = list();

    const one = ingestFiles([file("a")], update, vi.fn(), read);
    const two = ingestFiles([file("b")], update, vi.fn(), read);
    // Both reads started against an empty list; they finish in the order they started.
    first.resolve({ attachments: [tile("a")], rejected: [] });
    second.resolve({ attachments: [tile("b")], rejected: [] });
    await Promise.all([one, two]);
    expect(state.current.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not bring back a tile the user removed while a file was being read", async () => {
    const pending = deferred<{ attachments: Attachment[]; rejected: string[] }>();
    const { state, update } = list([tile("old")]);
    const done = ingestFiles([file("new")], update, vi.fn(), () => pending.promise);
    update((current) => current.filter((entry) => entry.id !== "old"));
    pending.resolve({ attachments: [tile("new")], rejected: [] });
    await done;
    expect(state.current.map((entry) => entry.id)).toEqual(["new"]);
  });

  it("says which files were too big, and adds the rest", async () => {
    const report = vi.fn();
    const { state, update } = list();
    await ingestFiles([file("a"), file("huge.mov")], update, report, async () => ({ attachments: [tile("a")], rejected: ["huge.mov"] }));
    expect(state.current).toHaveLength(1);
    expect(report).toHaveBeenCalledWith("huge.mov 超过 10.0 MB，没有添加");
  });

  it("does not touch the list when nothing was read, and reports a read that failed", async () => {
    const report = vi.fn();
    const update = vi.fn();
    await ingestFiles([file("a")], update, report, async () => ({ attachments: [], rejected: [] }));
    expect(update).not.toHaveBeenCalled();
    await ingestFiles([file("a")], update, report, async () => {
      throw new Error("读不了 a");
    });
    expect(report).toHaveBeenCalledWith("读不了 a");
    await ingestFiles([file("a")], update, report, async () => {
      throw "boom";
    });
    expect(report).toHaveBeenLastCalledWith("读取文件失败");
  });

  it("reads nothing for an empty drop", async () => {
    const read = vi.fn();
    await ingestFiles([], vi.fn(), vi.fn(), read);
    expect(read).not.toHaveBeenCalled();
  });
});
