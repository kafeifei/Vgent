import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { createThreadStore } from "./store/threads.js";
import { createQueueStore } from "./queue.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgent-queue-durable-"));
  dirs.push(dir);
  const threads = createThreadStore(dir);
  const thread = await threads.create({ projectId: "p", engine: "vgent" });
  return { dir, threads, thread, queue: createQueueStore(threads) };
};
it("peek survives reopening, transcript commit and queue consumption are atomic", async () => {
  const { dir, threads, thread, queue } = await setup();
  await queue.append(thread.id, "keep original delivery", "steer");
  const items = await queue.takeSteers(thread.id);
  expect((await createThreadStore(dir).get(thread.id))!.queue).toHaveLength(1);
  const messages: UIMessage[] = [
    {
      id: "assistant",
      role: "assistant",
      parts: [{ type: "data-steer", id: items[0]!.id, data: { text: items[0]!.text, messageId: items[0]!.id } }],
    },
  ];
  await queue.takeSteers(thread.id, () => messages);
  const recovered = await createThreadStore(dir).get(thread.id);
  expect(recovered!.messages).toEqual(messages);
  expect(recovered!.queue ?? []).toHaveLength(0);
  // An append based on a stale read must not resurrect a consumed input.
  await threads.update(thread.id, { queue: items });
  expect((await threads.get(thread.id))!.queue ?? []).toHaveLength(0);
});
it("failed transcript persistence leaves the input recoverable", async () => {
  const { dir, threads, thread, queue } = await setup();
  await queue.append(thread.id, "correction", "steer");
  const failed = createQueueStore({
    ...threads,
    update: async () => {
      throw new Error("disk full");
    },
  });
  await expect(failed.takeSteers(thread.id, () => [])).rejects.toThrow("disk full");
  expect((await createThreadStore(dir).get(thread.id))!.queue).toHaveLength(1);
});
it("normal queue claims remain durable until the input starts its turn", async () => {
  const { dir, threads, thread, queue } = await setup();
  await queue.append(thread.id, "next request");
  const item = (await queue.take(thread.id, { retain: true }))!;
  expect((await createThreadStore(dir).get(thread.id))!.queue).toHaveLength(1);
  await threads.update(thread.id, {
    messages: [{ id: item.id, role: "user", parts: [{ type: "text", text: item.text }] }],
    consumeQueueIds: [item.id],
  });
  const recovered = await createThreadStore(dir).get(thread.id);
  expect(recovered!.messages[0]!.id).toBe(item.id);
  expect(recovered!.queue ?? []).toHaveLength(0);
});

it("keeps a displayed push receipt pending, reserves manual sending, and never regresses applied", async () => {
  const { threads, thread, queue } = await setup();
  const record = await queue.append(thread.id, "guide", "steer");
  const item = record.queue![0]!;
  await queue.beginDelivery(thread.id, item.id);
  await expect(queue.remove(thread.id, item.id)).rejects.toThrow();
  await threads.saveMessages(thread.id, [{ id: "assistant", role: "assistant", parts: [
    { type: "data-steer", id: item.id, data: { text: item.text, messageId: item.id, receipt: true } },
  ] }]);
  await queue.markAccepted(thread.id, item.id, true);
  expect((await threads.get(thread.id))?.queue?.[0]).toMatchObject({ accepted: true, applied: false });
  await queue.reserveSend(thread.id, item.id, true);
  await expect(queue.reserveSend(thread.id, item.id, true)).rejects.toThrow();
  await expect(queue.edit(thread.id, item.id, "replacement")).rejects.toThrow();
  await queue.markApplied(thread.id, item.id);
  await queue.markAccepted(thread.id, item.id, false);
  expect((await threads.get(thread.id))?.queue?.[0]).toMatchObject({ accepted: true, applied: true });
  await queue.settleSteers(thread.id, [item.id], true);
  expect((await threads.get(thread.id))?.queue ?? []).toHaveLength(0);
});
