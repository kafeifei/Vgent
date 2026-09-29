import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToModelMessages, type ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreContext, saveContext } from "./context-cache.js";

vi.mock("node:fs/promises", { spy: true });

let dir: string;
const user = (content: string): ModelMessage => ({ role: "user", content });
const original = [user("long history")];
const effective = [user("summary")];
const dataUrl = "data:text/plain;base64,aGVsbG8=";
const attachment = () => convertToModelMessages([
  { id: "attachment", role: "user", parts: [{ type: "file", mediaType: "text/plain", url: dataUrl }] },
]);

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "vgent-context-cache-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("context cache", () => {
  it("reuses plain messages with optional undefined properties and writes mode 0600", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "hello", providerOptions: undefined }], providerOptions: undefined }];
    await saveContext(dir, messages, messages);
    const restored = await restoreContext(dir, [...messages, user("next")]);
    expect(restored).toEqual([...messages, user("next")]);
    expect(restored[0]).not.toBe(messages[0]);
    expect((await fs.stat(join(dir, "context-state.json"))).mode & 0o777).toBe(0o600);
    await saveContext(dir, messages, effective);
    expect(await restoreContext(dir, messages)).toEqual(effective);
  });

  it("preserves actual SDK data URL attachments across turns", async () => {
    const messages = await attachment();
    expect(messages[0]).toMatchObject({ content: [{ data: { type: "url", url: new URL(dataUrl) } }] });
    await saveContext(dir, messages, messages);
    expect(await fs.readdir(dir)).toEqual([]);
    const next = [...messages, user("next")];
    expect(await restoreContext(dir, next)).toBe(next);
    await saveContext(dir, next, next);
    expect(await restoreContext(dir, next)).toBe(next);
  });

  it.each([new Uint8Array([1, 2]), Buffer.from([1, 2])])("skips binary ModelMessages: %s", async (data) => {
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "file", mediaType: "application/octet-stream", data: { type: "data", data } }] }];
    await saveContext(dir, messages, effective);
    await saveContext(dir, original, messages);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("rejects an old v1 cache even when its lossy attachment digest matches", async () => {
    const messages = await attachment();
    await fs.writeFile(join(dir, "context-state.json"), JSON.stringify({
      version: 1, count: messages.length,
      digest: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), messages,
    }));
    expect(await restoreContext(dir, messages)).toBe(messages);
  });

  it("reuses a text prefix without serializing a new attachment tail", async () => {
    await saveContext(dir, original, effective);
    const tail = await attachment();
    const restored = await restoreContext(dir, [...original, ...tail]);
    expect(restored).toEqual([...effective, ...tail]);
    expect(restored[1]).toBe(tail[0]);
  });

  it.each([new Date(), new URL(dataUrl), 1n, () => {}, Symbol("value"), NaN, Infinity, [undefined], new Map(), Object.assign({}, { self: null })])("skips unsafe values without replacing an existing cache: %s", async (value) => {
    // Use an unknown tool input to exercise nested JSON safety independently of message validation.
    if (value && typeof value === "object" && "self" in value) value.self = value;
    const messages: ModelMessage[] = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "test", input: value }] }];
    await saveContext(dir, original, effective);
    const before = await fs.readFile(join(dir, "context-state.json"));
    await expect(saveContext(dir, messages, effective)).resolves.toBeUndefined();
    await expect(saveContext(dir, original, messages)).resolves.toBeUndefined();
    expect(await fs.readFile(join(dir, "context-state.json"))).toEqual(before);
  });

  it("treats a directory path that is a file as a cache miss", async () => {
    const blocked = join(dir, "blocked");
    await fs.writeFile(blocked, "keep");
    await expect(saveContext(blocked, original, effective)).resolves.toBeUndefined();
    expect(await fs.readFile(blocked, "utf8")).toBe("keep");
    expect(await fs.readdir(dir)).toEqual(["blocked"]);
  });

  it("cleans the temporary file when the destination is a directory", async () => {
    const path = join(dir, "context-state.json");
    await fs.mkdir(path);
    await fs.writeFile(join(path, "keep"), "keep");
    await expect(saveContext(dir, original, effective)).resolves.toBeUndefined();
    expect(await fs.readdir(dir)).toEqual(["context-state.json"]);
    expect(await fs.readFile(join(path, "keep"), "utf8")).toBe("keep");
  });

  it("swallows write and cleanup failures without replacing the old cache", async () => {
    await saveContext(dir, original, effective);
    const before = await fs.readFile(join(dir, "context-state.json"));
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("write failed"));
    const cleanup = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(saveContext(dir, original, [user("replacement")])).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalled();
    expect(await fs.readFile(join(dir, "context-state.json"))).toEqual(before);
  });
});
