import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDraft, DraftSync, NEW_TASK_DRAFT, pruneDrafts, type DraftAttachment, type DraftPayload, type DraftValue } from "./drafts";

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
      payloads.push({ text: draft.text, attachments: draft.attachments });
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

  it("flushes what is pending on task switch, with keepalive when the page is leaving", async () => {
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
    await sync.settled();
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
    await sync.settled();

    sync.edit("看这张图");
    vi.advanceTimersByTime(300);
    expect(transport.payloads.at(-1)).toEqual({ text: "看这张图", attachments: [PNG_META] });

    sync.clear();
    await sync.settled();
    expect(transport.payloads.at(-1)).toEqual({ text: "", attachments: [] });
    expect(sync.current).toEqual(value(""));
  });

  it("sends the bytes again after a failed write, since it is unknown how far it got", async () => {
    const transport = fakeTransport();
    const sync = new DraftSync(KEY, transport, () => {});

    transport.failNext();
    sync.setAttachments([PNG]);
    await sync.settled();
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
    await sync.settled();
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

it("clears a second text-only send when the view has its own empty attachment list", async () => {
  const transport = fakeTransport();
  const sync = new DraftSync(KEY, transport, () => {});
  sync.edit("第一条");
  expect(sync.clear(sync.current)).toBe(true);
  // useDraft paints a separate empty array after clear. This is still the
  // same empty attachment set, and the second send must clear it too.
  sync.edit("重画了？");
  const submitted = { text: "重画了？", attachments: [] };
  expect(sync.clear(submitted)).toBe(true);
  expect(sync.current).toEqual(value(""));
  expect(transport.payloads.at(-1)).toEqual(value(""));
});

it("accepts copied attachment metadata but preserves an attachment changed during sending", () => {
  const sync = new DraftSync(KEY, fakeTransport(), () => {});
  sync.edit("看这张图");
  sync.setAttachments([PNG]);
  const submitted = structuredClone(sync.current);
  sync.setAttachments([{ ...PNG, url: "data:image/png;base64,BAEC" }]);
  expect(sync.clear(submitted)).toBe(false);
  expect(sync.current.attachments[0]!.url).toBe("data:image/png;base64,BAEC");
  expect(sync.clear(structuredClone(sync.current))).toBe(true);
  expect(sync.current).toEqual(value(""));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A real changing remote value, not a fixed GET response. */
function savedTransport() {
  const saved = new Map<string, DraftValue>();
  const heads = new Map<string, number>();
  return {
    saved,
    getDraft: async (key: string) => structuredClone(saved.get(key) ?? value("")),
    putDraft: async (key: string, draft: DraftPayload) => {
      if (draft.writeId) {
        const writer = `${key}:${draft.writeId.clientId}`;
        if (draft.writeId.sequence <= (heads.get(writer) ?? 0)) return;
        heads.set(writer, draft.writeId.sequence);
      }
      saved.set(key, { text: draft.text, attachments: draft.attachments.map(file => ({ ...file, url: file.url ?? saved.get(key)?.attachments.find(old => old.id === file.id)?.url ?? "" })) });
    },
  };
}

describe("draft consumption survives navigation", () => {
  it.each([NEW_TASK_DRAFT, KEY])("clears accepted %s text and files after its input view unmounts", async key => {
    const transport = savedTransport();
    const first = acquireDraft(key, transport, () => {});
    first.sync.edit("这句已发送");
    first.sync.setAttachments([PNG]);
    const accept = deferred<boolean>();
    const sending = first.submit(() => accept.promise);
    first.release();
    accept.resolve(true);
    await sending;
    await first.sync.settled();
    expect(transport.saved.get(key)).toEqual(value(""));
    expect(cache.has(`vgent.draft.${key}`)).toBe(false);
    const reopened = acquireDraft(key, transport, () => {});
    await reopened.sync.start();
    expect(reopened.sync.current).toEqual(value(""));
    reopened.release();
  });

  it("clears a reopened view when acceptance arrives, and does not touch another task", async () => {
    const transport = savedTransport();
    const first = acquireDraft(KEY, transport, () => {});
    first.sync.edit("待确认");
    const accept = deferred<boolean>();
    const sending = first.submit(() => accept.promise);
    first.release();
    const paints: DraftValue[] = [];
    const reopened = acquireDraft(KEY, transport, draft => paints.push(draft));
    const other = acquireDraft("other", transport, () => {});
    other.sync.edit("另一个任务的草稿");
    accept.resolve(true);
    await sending;
    expect(paints.at(-1)).toEqual(value(""));
    expect(other.sync.current.text).toBe("另一个任务的草稿");
    reopened.release(); other.release();
    await Promise.all([reopened.sync.settled(), other.sync.settled()]);
  });

  it.each(["新的草稿", "原草稿"])("preserves later editing after reopening, even if it ends as %s", async text => {
    const transport = savedTransport();
    const first = acquireDraft(NEW_TASK_DRAFT, transport, () => {});
    first.sync.edit("原草稿");
    const accept = deferred<boolean>();
    const sending = first.submit(() => accept.promise);
    first.release();
    const reopened = acquireDraft(NEW_TASK_DRAFT, transport, () => {});
    reopened.sync.edit("");
    reopened.sync.edit(text);
    accept.resolve(true);
    await sending;
    expect(reopened.sync.current.text).toBe(text);
    reopened.release();
    await reopened.sync.settled();
    expect(transport.saved.get(NEW_TASK_DRAFT)?.text).toBe(text);
  });

  it("keeps a rejected send for reopening with all its attachments", async () => {
    const transport = savedTransport();
    const first = acquireDraft(KEY, transport, () => {});
    first.sync.edit("发送失败不能丢");
    first.sync.setAttachments([PNG]);
    const accept = deferred<boolean>();
    const sending = first.submit(() => accept.promise);
    first.release();
    accept.resolve(false);
    expect(await sending).toBe(false);
    await first.sync.settled();
    expect(transport.saved.get(KEY)).toEqual(value("发送失败不能丢", [PNG]));
  });

  it("retries a failed clear on reopening instead of resurrecting the sent draft", async () => {
    const transport = savedTransport();
    const put = transport.putDraft;
    let failClear = true;
    transport.putDraft = async (key, draft) => {
      if (draft.text === "" && failClear) throw new Error("offline");
      await put(key, draft);
    };
    const first = acquireDraft(KEY, transport, () => {});
    first.sync.edit("发送成功");
    first.sync.flush();
    await first.sync.settled();
    await first.submit(async () => true);
    await first.sync.settled();
    first.release();
    await first.sync.settled();
    failClear = false;
    const reopened = acquireDraft(KEY, transport, () => {});
    expect(reopened.sync.current).toEqual(value(""));
    await reopened.sync.settled();
    expect(transport.saved.get(KEY)).toEqual(value(""));
    reopened.release();
  });
});

it("numbers consumption after an earlier save even when that save completes last", async () => {
  const firstWrite = deferred<void>();
  const saved = savedTransport();
  const puts: DraftPayload[] = [];
  const transport = {
    ...saved,
    putDraft: async (key: string, draft: DraftPayload) => {
      puts.push(draft);
      if (puts.length === 1) await firstWrite.promise;
      await saved.putDraft(key, draft);
    },
  };
  const sync = new DraftSync(KEY, transport, () => {});
  sync.edit("已发出的旧内容");
  sync.setAttachments([PNG]);
  await sync.submit(async () => true);
  sync.dispose();
  expect(puts).toHaveLength(2);
  expect(puts[1]!.writeId!.sequence).toBeGreaterThan(puts[0]!.writeId!.sequence);
  firstWrite.resolve();
  await sync.settled();
  expect(puts).toHaveLength(2);
  expect(saved.saved.get(KEY)).toEqual(value(""));
});

it("does not restore a stale GET that arrives after the message was accepted", async () => {
  const remote = deferred<DraftValue>();
  const transport = { ...savedTransport(), getDraft: () => remote.promise };
  const sync = new DraftSync(KEY, transport, () => {});
  sync.edit("发出去的字");
  const loading = sync.start();
  await sync.submit(async () => true);
  remote.resolve(value("发出去的字", [PNG]));
  await loading;
  expect(sync.current).toEqual(value(""));
  await sync.settled();
});

it("starts the pagehide save immediately while another save is still pending", async () => {
  const pending = deferred<void>();
  const transport = savedTransport();
  const writes: Array<{ draft: DraftPayload; keepalive: boolean }> = [];
  const sync = new DraftSync(KEY, {
    ...transport,
    putDraft: async (_key, draft, options) => { writes.push({ draft, keepalive: !!options?.keepalive }); await pending.promise; },
  }, () => {});
  sync.edit("旧的字");
  sync.flush();
  sync.edit("关闭前刚写的新草稿");
  sync.flush({ keepalive: true });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ draft: { text: "关闭前刚写的新草稿" }, keepalive: true });
  pending.resolve();
  await sync.settled();
});
