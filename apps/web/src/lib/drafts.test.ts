import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftSync, NEW_TASK_DRAFT, pruneDrafts } from "./drafts";

const KEY = "t1";

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
function fakeTransport(remote: string | Promise<string> = "") {
  const puts: Array<{ key: string; text: string; keepalive: boolean }> = [];
  let fail = false;
  return {
    puts,
    failNext: () => {
      fail = true;
    },
    getDraft: () => Promise.resolve(remote),
    putDraft: (key: string, text: string, options?: { keepalive?: boolean }) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("离线"));
      }
      puts.push({ key, text, keepalive: options?.keepalive === true });
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
    const seen: string[] = [];
    const sync = new DraftSync(KEY, transport, (text) => seen.push(text));

    expect(sync.current).toBe("本地缓存的一半");
    await sync.start();
    expect(seen).toEqual(["服务端存的那份"]);
    expect(sync.current).toBe("服务端存的那份");
    // The cache now matches, so the next launch paints the right thing at once.
    expect(cache.get("vgent.draft.t1")).toBe("服务端存的那份");
  });

  it("keeps what the user has typed since mount, whatever the server says", async () => {
    const transport = fakeTransport("服务端存的那份");
    const seen: string[] = [];
    const sync = new DraftSync(KEY, transport, (text) => seen.push(text));

    sync.edit("我刚敲的");
    await sync.start();
    expect(seen).toEqual([]);
    expect(sync.current).toBe("我刚敲的");
  });

  it("leaves the cached text alone when the server cannot answer", async () => {
    cache.set("vgent.draft.t1", "只有本地有");
    const transport = { getDraft: () => Promise.reject(new Error("断线")), putDraft: () => Promise.resolve() };
    const sync = new DraftSync(KEY, transport, () => expect.unreachable("没有远端值就不该重画"));
    await sync.start();
    expect(sync.current).toBe("只有本地有");
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
