import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSync, NEW_TASK_DRAFT, pruneDrafts, type DraftAttachment, type DraftPayload, type DraftValue } from "./drafts";

const KEY = "t1";

const PNG: DraftAttachment = { id: "a1", name: "截图.png", mediaType: "image/png", url: "data:image/png;base64,AAEC", size: 3 };
const { url: _pngUrl, ...PNG_META } = PNG;

const value = (text: string, attachments: DraftAttachment[] = []): DraftValue => ({ text, attachments });

/** `localStorage`, as the cache layer uses it: node has none. */
function fakeStorage() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return entries;
}

/** The two draft routes, recorded. `remote` is what the server answers a `GET` with. */
function fakeTransport(remote: string | DraftValue = "") {
  const puts: Array<{ key: string; text: string; keepalive: boolean }> = [];
  /** The whole payload, for the tests that care about what rode along. */
  const payloads: DraftPayload[] = [];
  let fail = false;
  return {
    puts,
    payloads,
    failNext: () => {
      fail = true;
    },
    getDraft: () => Promise.resolve(typeof remote === "string" ? value(remote) : remote),
    putDraft: (key: string, draft: DraftPayload, options?: { keepalive?: boolean }) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("离线"));
      }
      puts.push({ key, text: draft.text, keepalive: options?.keepalive === true });
      payloads.push(draft);
      return Promise.resolve();
    },
  };
}

let cache: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  cache = fakeStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DraftSync 打开任务", () => {
  it("paints the cached text first and then lets the server's copy win", async () => {
    cache.set("vgent.draft.t1", "本地缓存的一半");
    const transport = fakeTransport("服务端存的那份");
    const seen: DraftValue[] = [];
    const sync = new DraftSync(KEY, transport, (draft) => seen.push(draft));

    expect(sync.current).toEqual(value("本地缓存的一半"));
    await sync.start();
    expect(seen).toEqual([value("服务端存的那份")]);
    expect(sync.current).toEqual(value("服务端存的那份"));
    // The cache now matches, so the next launch paints the right thing at once.
    expect(cache.get("vgent.draft.t1")).toBe("服务端存的那份");
  });

  it("keeps what the user has typed since mount, whatever the server says", async () => {
    const transport = fakeTransport("服务端存的那份");
    const seen: DraftValue[] = [];
    const sync = new DraftSync(KEY, transport, (draft) => seen.push(draft));

    sync.edit("我刚敲的");
    await sync.start();
    expect(seen).toEqual([]);
    expect(sync.current).toEqual(value("我刚敲的"));
  });

  it("brings the server's files in even when the user has already typed, and never sends their bytes back", async () => {
    const transport = fakeTransport(value("服务端的字", [PNG]));
    const seen: DraftValue[] = [];
    const sync = new DraftSync(KEY, transport, (draft) => seen.push(draft));

    sync.edit("我刚敲的");
    await sync.start();
    // The text the user typed stays; the files were not touched, so they arrive.
    expect(seen).toEqual([value("我刚敲的", [PNG])]);

    sync.edit("我刚敲的，再来");
    vi.advanceTimersByTime(300);
    expect(transport.payloads.at(-1)).toEqual({ text: "我刚敲的，再来", attachments: [PNG_META] });
  });

  it("keeps the files the user changed since mount over the server's", async () => {
    const other: DraftAttachment = { ...PNG, id: "z9", name: "另一张.png" };
    const transport = fakeTransport(value("", [PNG]));
    const sync = new DraftSync(KEY, transport, () => expect.unreachable("本地已经动过附件，服务端那份不该盖过来"));

    sync.setAttachments([other]);
    await sync.start();
    expect(sync.current.attachments).toEqual([other]);
  });

  it("leaves the cached text alone when the server cannot answer", async () => {
    cache.set("vgent.draft.t1", "只有本地有");
    const transport = { getDraft: () => Promise.reject(new Error("断线")), putDraft: () => Promise.resolve() };
    const sync = new DraftSync(KEY, transport, () => expect.unreachable("没有远端值就不该重画"));
    await sync.start();
    expect(sync.current).toEqual(value("只有本地有"));
  });
});

describe("DraftSync 写回", () => {
  it("caches every keystroke but only writes 300 ms after the last one", () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    sync.edit("一");
    sync.edit("一二");
    vi.advanceTimersByTime(299);
    expect(transport.puts).toEqual([]);
    // The cache is not debounced: a reload in this window still finds the text.
    expect(cache.get("vgent.draft.t1")).toBe("一二");

    vi.advanceTimersByTime(1);
    expect(transport.puts).toEqual([{ key: KEY, text: "一二", keepalive: false }]);
  });

  it("writes every 2 s while the typing never pauses", () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    for (let tick = 0; tick < 10; tick++) {
      sync.edit(`第 ${tick} 下`);
      vi.advanceTimersByTime(200);
    }
    // 2 s of uninterrupted typing: the ceiling fired once, the debounce never did.
    expect(transport.puts).toHaveLength(1);
    expect(transport.puts[0]?.text).toBe("第 9 下");
  });

  it("flushes what is pending on task switch, with keepalive when the page is leaving", () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    sync.edit("还没到 300 毫秒");
    sync.flush({ keepalive: true });
    expect(transport.puts).toEqual([{ key: KEY, text: "还没到 300 毫秒", keepalive: true }]);

    // Nothing pending: a second flush is not a second request.
    sync.flush();
    expect(transport.puts).toHaveLength(1);

    sync.edit("切任务之前又敲了");
    sync.dispose();
    expect(transport.puts).toHaveLength(2);
    expect(transport.puts[1]).toEqual({ key: KEY, text: "切任务之前又敲了", keepalive: false });
  });

  it("clears the draft on both sides the moment a message goes out", () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    sync.edit("发出去的这句");
    sync.clear();
    // Not on the next timer: a pending write would put the sent text back.
    expect(transport.puts).toEqual([{ key: KEY, text: "", keepalive: false }]);
    expect(cache.get("vgent.draft.t1")).toBeUndefined();

    vi.advanceTimersByTime(5000);
    expect(transport.puts).toHaveLength(1);
  });

  it("does not clear newer typing or attachments when an older send finishes", () => {
    const sync = new DraftSync(KEY, fakeTransport(), () => {});
    sync.edit("第一条");
    const sent = sync.current;
    sync.edit("后来写的");
    expect(sync.clear(sent)).toBe(false);
    expect(sync.current.text).toBe("后来写的");
    const second = sync.current;
    sync.setAttachments([PNG]);
    expect(sync.clear(second)).toBe(false);
    expect(sync.current.attachments).toEqual([PNG]);
    expect(sync.clear(sync.current)).toBe(true);
    expect(sync.current.text).toBe("");
  });

  it("sends a new file at once with its bytes, then names it by id, and clears it with the text", async () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    sync.edit("看这张");
    sync.setAttachments([PNG]);
    // Not on the debounce: the file is on the server before the timer would fire.
    expect(transport.payloads).toEqual([{ text: "看这张", attachments: [PNG] }]);
    await Promise.resolve();

    sync.edit("看这张图");
    vi.advanceTimersByTime(300);
    expect(transport.payloads.at(-1)).toEqual({ text: "看这张图", attachments: [PNG_META] });

    sync.clear();
    expect(transport.payloads.at(-1)).toEqual({ text: "", attachments: [] });
    expect(sync.current).toEqual(value(""));
  });

  it("sends the bytes again after a failed write, since it is unknown how far it got", async () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    transport.failNext();
    sync.setAttachments([PNG]);
    await Promise.resolve();
    expect(transport.payloads).toEqual([]);

    sync.edit("再试");
    vi.advanceTimersByTime(300);
    expect(transport.payloads).toEqual([{ text: "再试", attachments: [PNG] }]);
  });

  it("removing a tile writes the shorter list right away", async () => {
    const transport = fakeTransport(value("", [PNG]));
    const sync = new DraftSync(KEY, transport, () => {});
    await sync.start();

    sync.setAttachments([]);
    expect(transport.payloads).toEqual([{ text: "", attachments: [] }]);
  });

  it("retries on the next keystroke when a write fails", async () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    transport.failNext();
    sync.edit("第一次写不上去");
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(transport.puts).toEqual([]);

    sync.edit("第一次写不上去，再敲一个字");
    vi.advanceTimersByTime(300);
    expect(transport.puts).toEqual([{ key: KEY, text: "第一次写不上去，再敲一个字", keepalive: false }]);
  });
});

describe("pruneDrafts", () => {
  it("drops the cache of tasks that are gone and keeps the empty state's", () => {
    cache.set("vgent.draft.alive", "留着");
    cache.set("vgent.draft.dead", "删掉");
    cache.set(`vgent.draft.${NEW_TASK_DRAFT}`, "空状态的");
    cache.set("vgent.theme", "light");

    pruneDrafts(["alive"]);
    expect([...cache.keys()].sort()).toEqual(["vgent.draft.alive", `vgent.draft.${NEW_TASK_DRAFT}`, "vgent.theme"].sort());
  });
});
