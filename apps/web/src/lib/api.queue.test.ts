import type { FileUIPart } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "./api";

afterEach(() => vi.unstubAllGlobals());
it("POSTs full files with an attachment-only queued message", async () => {
  const fetch = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const files: FileUIPart[] = [{ type: "file", filename: "note.txt", mediaType: "text/plain", url: "data:text/plain,hello" }];
  await createClient("fixture").queueMessage("thread", "", "queue", files);
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/threads/thread/queue");
  expect(options.method).toBe("POST");
  expect(JSON.parse(options.body as string)).toEqual({ text: "", mode: "queue", files });
});
it("keeps text-only steer defaults and PATCH edits text without replacing files", async () => {
  const fetch = vi.fn(async () => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  const client = createClient("fixture");
  await client.queueMessage("thread", "hello");
  await client.editQueued("thread", "item", "");
  const calls = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(JSON.parse(calls[0]![1].body as string)).toEqual({ text: "hello", mode: "steer", files: [] });
  expect(calls[1]![1].method).toBe("PATCH");
  expect(JSON.parse(calls[1]![1].body as string)).toEqual({ text: "" });
});
