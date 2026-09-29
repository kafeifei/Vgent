import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileUIPart } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueStore, QUEUE_FILES_MAX_BYTES, QUEUE_FILE_URLS_MAX_BYTES, readQueueFiles } from "./queue.js";
import { MAX_DRAFT_ATTACHMENT_BYTES, MAX_DRAFT_ATTACHMENTS } from "./store/drafts.js";
import { createThreadStore } from "./store/threads.js";

const file = (url = "data:text/plain;base64,aGVsbG8="): FileUIPart => ({ type: "file", mediaType: "text/plain", filename: "note.txt", url });
const sizedFile = (bytes: number): FileUIPart => file(`data:text/plain;base64,${Buffer.alloc(bytes, 97).toString("base64")}`);
const tooLarge = { status: 413, code: "queue_files_too_large" };
const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("readQueueFiles", () => {
  it("缺省、空数组、base64 和 percent data URL 可读，保留原始 URL", () => {
    expect(readQueueFiles(undefined)).toEqual([]);
    expect(readQueueFiles([])).toEqual([]);
    const files = [file(), file("data:text/plain,%E4%BD%A0%E5%A5%BD%20world")];
    expect(readQueueFiles(files)).toEqual(files);
    expect(readQueueFiles([{ type: "file", mediaType: "image/png", url: "data:image/png;base64,aGk=" }])).toHaveLength(1);
  });

  it.each([
    ["null", null],
    ["object", {}],
    ["string", "file"],
    ["null part", [null]],
    ["primitive part", [1]],
    ["wrong part", [{ ...file(), type: "text" }]],
    ["missing MIME", [{ ...file(), mediaType: undefined }]],
    ["invalid MIME", [{ ...file(), mediaType: "text" }]],
    ["MIME parameters", [{ ...file(), mediaType: "text/plain;charset=utf-8" }]],
    ["MIME mismatch", [file("data:image/png;base64,aGk=")]],
    ["missing URL", [{ ...file(), url: undefined }]],
    ["invalid URL type", [{ ...file(), url: 123 }]],
    ["remote URL", [file("https://example.com/note.txt")]],
    ["blob URL", [file("blob:http://localhost/123")]],
    ["missing data delimiter", [file("data:text/plain;base64")]],
    ["invalid base64 alphabet", [file("data:text/plain;base64,!!!!")]],
    ["invalid base64 length", [file("data:text/plain;base64,YQ=")]],
    ["invalid base64 padding", [file("data:text/plain;base64,Y=Q=")]],
    ["too much base64 padding", [file("data:text/plain;base64,Y===")]],
    ["base64 whitespace", [file("data:text/plain;base64,YQ==\n")]],
    ["invalid percent escape", [file("data:text/plain,%ZZ")]],
    ["truncated percent escape", [file("data:text/plain,%2")]],
    ["invalid percent UTF-8", [file("data:text/plain,%FF")]],
    ["invalid filename", [{ ...file(), filename: 1 }]],
  ])("拒绝未知载荷：%s", (_label, value) => {
    expect(() => readQueueFiles(value)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_queue_files" }));
  });

  it("每条最多 20 个附件，超出返回 413", () => {
    expect(MAX_DRAFT_ATTACHMENTS).toBe(20);
    expect(readQueueFiles(Array.from({ length: MAX_DRAFT_ATTACHMENTS }, () => file()))).toHaveLength(MAX_DRAFT_ATTACHMENTS);
    expect(() => readQueueFiles(Array.from({ length: MAX_DRAFT_ATTACHMENTS + 1 }, () => file()))).toThrowError(expect.objectContaining(tooLarge));
  });

  it("单个附件按解码字节限制 10 MiB，而不是 base64 字符数", () => {
    expect(MAX_DRAFT_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    const boundary = sizedFile(MAX_DRAFT_ATTACHMENT_BYTES);
    expect(readQueueFiles([boundary])).toEqual([boundary]);
    expect(() => readQueueFiles([sizedFile(MAX_DRAFT_ATTACHMENT_BYTES + 1)])).toThrowError(expect.objectContaining(tooLarge));
    expect(() => readQueueFiles([file(`data:text/plain,${"a".repeat(MAX_DRAFT_ATTACHMENT_BYTES + 1)}`)])).toThrowError(expect.objectContaining(tooLarge));
  });

  it("每消息解码后总计最多 20 MiB，不能用多个合法小文件绕过", () => {
    expect(QUEUE_FILES_MAX_BYTES).toBe(20 * 1024 * 1024);
    const files = [sizedFile(MAX_DRAFT_ATTACHMENT_BYTES), sizedFile(QUEUE_FILES_MAX_BYTES - MAX_DRAFT_ATTACHMENT_BYTES)];
    expect(readQueueFiles(files)).toEqual(files);
    expect(() => readQueueFiles([...files, sizedFile(1)])).toThrowError(expect.objectContaining(tooLarge));
  });
});

it("整条队列的 encoded URL 最多 64 MiB，拒绝追加不破坏原队列，删除后释放容量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-queue-files-"));
  dirs.push(dir);
  const threads = createThreadStore(dir);
  let record = await threads.create({ projectId: "project", engine: "claude-code" });
  // Keep large payloads in memory: exercise the real queue's lock and validation,
  // without repeatedly writing tens of MiB just to check byte accounting.
  vi.spyOn(threads, "get").mockImplementation(async () => record);
  vi.spyOn(threads, "update").mockImplementation(async (_id, patch) => (record = { ...record, ...patch }));
  const queue = createQueueStore(threads);
  expect(QUEUE_FILE_URLS_MAX_BYTES).toBe(64 * 1024 * 1024);
  const prefix = "data:text/plain,";
  const urlBytes = QUEUE_FILE_URLS_MAX_BYTES / 8;
  const payloadBytes = urlBytes - prefix.length;
  // Percent encoding occupies 3x the decoded bytes: decoded-total accounting
  // would incorrectly allow another message after this queue is full.
  const attachment = file(prefix + "%61".repeat(Math.floor(payloadBytes / 3)) + "a".repeat(payloadBytes % 3));
  for (let index = 0; index < 8; index++) {
    await queue.append(record.id, "", "queue", [attachment]);
  }
  expect(record.queue).toHaveLength(8);
  const before = record.queue;
  await expect(queue.append(record.id, "", "queue", [file()])).rejects.toMatchObject(tooLarge);
  expect(record.queue).toEqual(before);
  await queue.remove(record.id, record.queue![0]!.id);
  await queue.append(record.id, "", "queue", [file()]);
  expect(record.queue).toHaveLength(8);
});
