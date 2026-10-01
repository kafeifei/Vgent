/**
 * A task's 基线 is the tree its first turn started from. It is recorded once the
 * start's `running` write has landed: a start that 停止 cancels while its
 * snapshot is still being taken, or that fails after it, never began a turn, and
 * a baseline pinned for it would count whatever the user changed by hand before
 * sending again as the task's.
 *
 * The snapshot itself is held in the test's hands; nothing else of
 * `checkpoints.js` is replaced.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextStreamPart, ToolSet, UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineRegistry, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import { createQueueStore } from "./queue.js";
import { RESTART_RESUME_TEXT } from "./restart.js";
import { createRunManager, TurnStartCancelledError, type RunManager } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore, type ThreadStore } from "./store/threads.js";

const snapshot = vi.hoisted(() => ({
  /** What taking the snapshot waits for. */
  held: Promise.resolve() as Promise<void>,
  taken: 0,
  pinned: [] as string[],
}));

vi.mock("./checkpoints.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./checkpoints.js")>();
  return {
    ...original,
    createCheckpoint: vi.fn(async () => {
      snapshot.taken += 1;
      await snapshot.held;
      return { commit: "c0ffee", ref: "refs/vgent/checkpoints/t/000001" };
    }),
    pinBaseline: vi.fn(async (options: { commit?: string }) => {
      snapshot.pinned.push(options.commit ?? "");
      return options.commit;
    }),
  };
});

const dirs: string[] = [];
const managers: RunManager[] = [];

beforeEach(() => {
  snapshot.held = Promise.resolve();
  snapshot.taken = 0;
  snapshot.pinned = [];
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((runs) => runs.stopAll()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const part = (value: unknown) => value as TextStreamPart<ToolSet>;

const engine: EngineFactoryOverride = {
  async create(): Promise<EngineRunner> {
    return {
      hasUnfinishedTurn: () => false,
      async stream() {
        const chunks = (async function* () {
          yield part({ type: "start" });
          yield part({ type: "text-start", id: "t1" });
          yield part({ type: "text-delta", id: "t1", text: "好的" });
          yield part({ type: "text-end", id: "t1" });
        })();
        return { stream: ReadableStream.from(chunks) as ReadableStream<TextStreamPart<ToolSet>> };
      },
      async finish() {},
      async destroy() {},
    };
  },
};

/** `wrap` stands between the manager and the store, to make one kind of write fail. */
async function setup(wrap?: (threads: ThreadStore) => ThreadStore) {
  const dir = await mkdtemp(join(tmpdir(), "vgent-baseline-"));
  dirs.push(dir);
  const threads = createThreadStore(dir);
  const projects = createProjectStore(dir);
  const project = await projects.create({ repoPath: dir });
  const thread = await threads.create({ projectId: project.id, engine: "claude-code" });
  const runs = createRunManager({
    threads: wrap?.(threads) ?? threads,
    projects,
    settings: createSettingsStore(dir),
    dataDir: dir,
    registry: createEngineRegistry({ "claude-code": engine }),
    queue: createQueueStore(threads),
  });
  managers.push(runs);
  return { threads, thread, runs };
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时: ${what}`);
}

describe("任务基线只在启动不会再被取消之后才记", () => {
  it("快照还在拍的时候被停止：这次启动没有开始过，不留基线", async () => {
    const { threads, thread, runs } = await setup();
    let open!: () => void;
    snapshot.held = new Promise<void>((resolve) => {
      open = resolve;
    });

    const start = runs.start(thread.id, [userMessage("u1", "你好")]);
    const cancelled = expect(start).rejects.toBeInstanceOf(TurnStartCancelledError);
    await waitFor("the snapshot is being taken", () => snapshot.taken === 1);

    const stopping = runs.stop(thread.id);
    open();
    await cancelled;
    await stopping;

    expect(snapshot.pinned).toEqual([]);
    const record = await threads.get(thread.id);
    expect(record?.baselineCommit).toBeUndefined();
    expect(record).toMatchObject({ status: "idle", messages: [] });
  });

  it("没被取消的第一轮：基线就是它开跑前拍下的那个快照", async () => {
    const { threads, thread, runs } = await setup();

    const hub = await runs.start(thread.id, [userMessage("u1", "你好")]);
    for await (const _chunk of hub.subscribe()) void _chunk;

    expect(snapshot.pinned).toEqual(["c0ffee"]);
    expect((await threads.get(thread.id))?.baselineCommit).toBe("c0ffee");
  });

  it("标记 running 的那次写入失败：这一轮没有开始过，同样不留基线", async () => {
    const { threads, thread, runs } = await setup((store) => ({
      ...store,
      async update(id, patch, guard) {
        if (patch.status === "running") throw new Error("磁盘写满了");
        return store.update(id, patch, guard);
      },
    }));

    await expect(runs.start(thread.id, [userMessage("u1", "你好")])).rejects.toThrow("磁盘写满了");

    expect(snapshot.pinned).toEqual([]);
    const record = await threads.get(thread.id);
    expect(record?.baselineCommit).toBeUndefined();
    expect(record).toMatchObject({ status: "idle", messages: [] });
  });

  it("自动继续在快照之后被取代（任务被归档）：这一轮没有开始过，同样不留基线", async () => {
    const { threads, thread, runs } = await setup();
    await threads.update(thread.id, { status: "interrupted", restartRecovery: "recovery-1", messages: [userMessage("u0", "原来的活")] });
    let open!: () => void;
    snapshot.held = new Promise<void>((resolve) => {
      open = resolve;
    });

    const resuming = runs.resumeInterrupted(thread.id);
    await waitFor("the snapshot is being taken", () => snapshot.taken === 1);
    // Archiving cancels the restart intent, so the resume's own claim on it fails.
    await threads.update(thread.id, { archivedAt: new Date().toISOString() });
    open();
    await resuming;

    expect(snapshot.pinned).toEqual([]);
    const record = await threads.get(thread.id);
    expect(record?.baselineCommit).toBeUndefined();
    expect(JSON.stringify(record?.messages)).not.toContain(RESTART_RESUME_TEXT);
  });
});
