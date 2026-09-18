import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isToolUIPart, type ModelMessage, type TextStreamPart, type ToolSet, type UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import {
  changedPaths,
  CHECKPOINT_RETENTION,
  checkpointRefPrefix,
  createAfterCheckpoint,
  createCheckpoint,
  deleteCheckpoints,
  pinBaseline,
  restoreCheckpoint,
  snapshotTree,
} from "./checkpoints.js";
import { lastTurnPair, planRestore, restoreNote, turnSnapshots } from "./restore.js";
import { createEngineRegistry, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
import type { ChangesResponse } from "./git.js";
import type { Project, ThreadMessageMetadata, ThreadRecord } from "./types.js";

const exec = promisify(execFile);
const hasGit = spawnSync("git", ["--version"]).status === 0;

const TOKEN = "test-token-0123456789";
const ORIGIN = "http://127.0.0.1:7413";

const dirs: string[] = [];
const apps: VgentApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-checkpoint-"));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd });

/** A repo with one commit, a `.gitignore`, and an ignored file that must never move. */
async function repoWithHistory(): Promise<string> {
  const repo = await tempDir();
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@vgent.local");
  await git(repo, "config", "user.name", "Vgent Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
  await writeFile(join(repo, "tracked.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "初始");
  await writeFile(join(repo, "ignored.txt"), "别动我\n");
  return repo;
}

const read = (repo: string, path: string) => readFile(join(repo, path), "utf8");
const missing = (repo: string, path: string) =>
  stat(join(repo, path)).then(
    () => false,
    () => true,
  );
const refNames = async (repo: string, threadId: string): Promise<string[]> =>
  (await git(repo, "for-each-ref", "--format=%(refname)", "--", `${checkpointRefPrefix(threadId)}/`)).stdout
    .split("\n")
    .filter((line) => line.length > 0);

describe.skipIf(!hasGit)("checkpoints", () => {
  it("快照记录整个工作目录，但不碰真实索引", async () => {
    const repo = await repoWithHistory();
    await writeFile(join(repo, "tracked.txt"), "two\n");
    await writeFile(join(repo, "新文件.txt"), "新的\n");
    // A staged edit, so the real index is something we can check stayed put.
    await git(repo, "add", "tracked.txt");
    const stagedBefore = (await git(repo, "diff", "--cached", "--name-only")).stdout;

    const tree = await snapshotTree(repo);
    const listing = (await git(repo, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", tree)).stdout
      .split("\n")
      .filter(Boolean);
    expect(listing).toEqual([".gitignore", "tracked.txt", "新文件.txt"]);
    expect((await git(repo, "diff", "--cached", "--name-only")).stdout).toBe(stagedBefore);
  });

  it("同一秒内改的、大小又一样的文件也算进快照", async () => {
    const repo = await repoWithHistory();
    // Same second as the commit that wrote the index, and the same 4 bytes:
    // git compares whole seconds, so nothing but the index's own timestamp
    // tells it to look at the content again.
    await writeFile(join(repo, "tracked.txt"), "two\n");
    // Past that second, which is when a stale stat cache would start lying.
    await sleep(1100);

    const tree = await snapshotTree(repo);
    expect((await git(repo, "cat-file", "-p", `${tree}:tracked.txt`)).stdout).toBe("two\n");
  });

  it("恢复：改过的写回来，删掉的回来，之后新建的删掉，忽略的文件和真实索引都不动", async () => {
    const repo = await repoWithHistory();
    await mkdir(join(repo, "子目录"), { recursive: true });
    await writeFile(join(repo, "子目录", "留下.txt"), "保留\n");
    await writeFile(join(repo, "删掉我.txt"), "回合前就有\n");
    await git(repo, "add", "-A");
    const stagedBefore = (await git(repo, "status", "--porcelain")).stdout;

    const taken = await createCheckpoint({ repoPath: repo, threadId: "t1" });
    expect(taken).toBeDefined();

    // What "the engine did during the turn".
    await writeFile(join(repo, "tracked.txt"), "two\n");
    await rm(join(repo, "删掉我.txt"));
    await mkdir(join(repo, "新目录"), { recursive: true });
    await writeFile(join(repo, "新目录", "新文件.txt"), "之后建的\n");
    await writeFile(join(repo, "ignored.txt"), "改过但被忽略\n");

    const moved = await restoreCheckpoint({ repoPath: repo, commit: taken!.commit });
    expect(moved).toEqual({ written: 2, deleted: 1 });

    expect(await read(repo, "tracked.txt")).toBe("one\n");
    expect(await read(repo, "删掉我.txt")).toBe("回合前就有\n");
    expect(await missing(repo, "新目录/新文件.txt")).toBe(true);
    // The directory the removed file lived in went with it.
    expect(await missing(repo, "新目录")).toBe(true);
    expect(await read(repo, "子目录/留下.txt")).toBe("保留\n");
    // Ignored files are in neither tree, so nothing here ever looked at them.
    expect(await read(repo, "ignored.txt")).toBe("改过但被忽略\n");
    // HEAD and the real index are exactly where the user left them.
    expect((await git(repo, "status", "--porcelain")).stdout).toBe(stagedBefore);
    expect((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe("main");
  });

  it("恢复本身可以撤销：先存一份当前状态，再回到它", async () => {
    const repo = await repoWithHistory();
    const first = await createCheckpoint({ repoPath: repo, threadId: "t1" });
    await writeFile(join(repo, "tracked.txt"), "two\n");
    await writeFile(join(repo, "b.txt"), "第二轮\n");

    const undo = await createCheckpoint({ repoPath: repo, threadId: "t1", undo: true });
    expect(undo?.ref).toMatch(/\/undo-\d+$/);

    await restoreCheckpoint({ repoPath: repo, commit: first!.commit });
    expect(await read(repo, "tracked.txt")).toBe("one\n");
    expect(await missing(repo, "b.txt")).toBe(true);

    await restoreCheckpoint({ repoPath: repo, commit: undo!.commit });
    expect(await read(repo, "tracked.txt")).toBe("two\n");
    expect(await read(repo, "b.txt")).toBe("第二轮\n");
  });

  it("还没有提交的仓库也能打快照", async () => {
    const repo = await tempDir();
    await git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "a.txt"), "one\n");
    const taken = await createCheckpoint({ repoPath: repo, threadId: "t1" });
    expect(taken).toBeDefined();
    await writeFile(join(repo, "a.txt"), "two\n");
    await restoreCheckpoint({ repoPath: repo, commit: taken!.commit });
    expect(await read(repo, "a.txt")).toBe("one\n");
  });

  it("不是 git 仓库就没有快照，也不报错", async () => {
    const plain = await tempDir();
    await writeFile(join(plain, "a.txt"), "one\n");
    expect(await createCheckpoint({ repoPath: plain, threadId: "t1" })).toBeUndefined();
  });

  it("回合结束后的快照挂在同一个计数上，两个快照之间就是这一轮动过的文件", async () => {
    const repo = await repoWithHistory();
    await writeFile(join(repo, "改过的.txt"), "回合前\n");
    const before = await createCheckpoint({ repoPath: repo, threadId: "t1" });
    expect(before).toBeDefined();

    // What the engine did during the turn.
    await writeFile(join(repo, "改过的.txt"), "回合后\n");
    await writeFile(join(repo, "新建的.txt"), "新的\n");
    await rm(join(repo, "tracked.txt"));
    // An ignored file is in neither tree, so it never counts as touched.
    await writeFile(join(repo, "ignored.txt"), "跑的时候也动了\n");

    const after = await createAfterCheckpoint({ repoPath: repo, threadId: "t1", before: before! });
    expect(after?.ref).toBe(`${checkpointRefPrefix("t1")}/after-000001`);
    // Committed on top of the before-snapshot, which is what makes the pair a diff.
    expect((await git(repo, "rev-parse", `${after!.commit}^`)).stdout.trim()).toBe(before!.commit);

    expect((await changedPaths({ repoPath: repo, from: before!.commit, to: after!.commit })).sort()).toEqual([
      "tracked.txt",
      "改过的.txt",
      "新建的.txt",
    ]);
  });

  it("回合前的快照不是本线程的编号引用时，结束快照直接放弃，不报错", async () => {
    const repo = await repoWithHistory();
    const baseline = await pinBaseline({ repoPath: repo, threadId: "t1" });
    // The 基线 ref carries no counter, so there is no `after-<n>` to pair with it.
    const taken = await createAfterCheckpoint({
      repoPath: repo,
      threadId: "t1",
      before: { commit: baseline!, ref: `${checkpointRefPrefix("t1")}/base` },
    });
    expect(taken).toBeUndefined();
  });

  it(`只保留最新的 ${CHECKPOINT_RETENTION} 条引用，任务基线不算在内，删除任务时全部清掉`, async () => {
    const repo = await repoWithHistory();
    // The 任务基线 is pinned before the first turn and has to outlive every cap.
    const baseline = await pinBaseline({ repoPath: repo, threadId: "t1" });
    expect(baseline).toMatch(/^[0-9a-f]{40}$/);

    for (let i = 0; i < CHECKPOINT_RETENTION + 5; i += 1) {
      await writeFile(join(repo, "tracked.txt"), `第 ${i} 轮\n`);
      expect(await createCheckpoint({ repoPath: repo, threadId: "t1" })).toBeDefined();
    }
    const kept = await refNames(repo, "t1");
    const numbered = kept.filter((ref) => !ref.endsWith("/base"));
    expect(numbered).toHaveLength(CHECKPOINT_RETENTION);
    expect(numbered.at(0)).toBe(`${checkpointRefPrefix("t1")}/000006`);
    expect(numbered.at(-1)).toBe(`${checkpointRefPrefix("t1")}/000055`);
    expect(kept).toContain(`${checkpointRefPrefix("t1")}/base`);
    expect((await git(repo, "rev-parse", `${checkpointRefPrefix("t1")}/base`)).stdout.trim()).toBe(baseline);

    expect(await deleteCheckpoints({ repoPath: repo, threadId: "t1" })).toBe(CHECKPOINT_RETENTION + 1);
    expect(await refNames(repo, "t1")).toEqual([]);
  }, 60_000);

  it(`保留的是最新的 ${CHECKPOINT_RETENTION} 个回合，回合结束的快照跟着自己那一轮一起留、一起删`, async () => {
    const repo = await repoWithHistory();
    for (let i = 0; i < CHECKPOINT_RETENTION + 3; i += 1) {
      await writeFile(join(repo, "tracked.txt"), `第 ${i} 轮开跑\n`);
      const before = await createCheckpoint({ repoPath: repo, threadId: "t1" });
      await writeFile(join(repo, "tracked.txt"), `第 ${i} 轮跑完\n`);
      expect(await createAfterCheckpoint({ repoPath: repo, threadId: "t1", before: before! })).toBeDefined();
    }
    const kept = await refNames(repo, "t1");
    // Two refs per turn, and still exactly 50 turns: the pair shares a counter.
    expect(kept).toHaveLength(CHECKPOINT_RETENTION * 2);
    expect(kept).toContain(`${checkpointRefPrefix("t1")}/000004`);
    expect(kept).toContain(`${checkpointRefPrefix("t1")}/after-000004`);
    // Turn 3 fell off the end and its after-snapshot went with it, rather than
    // leaving a half-kept turn that could only degrade to a whole-tree restore.
    expect(kept).not.toContain(`${checkpointRefPrefix("t1")}/000003`);
    expect(kept).not.toContain(`${checkpointRefPrefix("t1")}/after-000003`);
  }, 60_000);
}, 30_000);

// --- 恢复的范围, without any git at all ------------------------------------

const turnMessage = (id: string, text: string, before: string, after?: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  metadata: {
    checkpoint: { commit: before, ref: `r/${before}`, at: "2026-09-19T00:00:00.000Z" },
    ...(after != null ? { checkpointAfter: { commit: after, ref: `r/${after}`, at: "2026-09-19T00:01:00.000Z" } } : {}),
  } satisfies ThreadMessageMetadata,
});

describe("恢复的范围", () => {
  const threadOf = (messages: UIMessage[], restoredTo?: { messageId: string; undoCommit: string }) =>
    ({ messages, ...(restoredTo != null ? { restoredTo: { ...restoredTo, at: "2026-09-19T00:02:00.000Z" } } : {}) }) as Pick<
      ThreadRecord,
      "messages" | "restoredTo"
    >;

  it("每条带快照的用户消息就是一轮；没有结束快照的那一轮也在，只是缺一半", () => {
    const messages = [turnMessage("u1", "一", "b1", "a1"), turnMessage("u2", "二", "b2")];
    expect(turnSnapshots(messages)).toEqual([
      { messageId: "u1", before: "b1", after: "a1" },
      { messageId: "u2", before: "b2" },
    ]);
    // A message with no checkpoint at all never was a turn.
    expect(turnSnapshots([{ id: "u0", role: "user", parts: [] }])).toEqual([]);
  });

  it("有回合没记下结束状态，就整目录回退，而且明说", async () => {
    const messages = [turnMessage("u1", "一", "b1", "a1"), turnMessage("u2", "二", "b2")];
    const plan = await planRestore({
      repoPath: "/nonexistent",
      thread: threadOf(messages),
      target: { messageId: "u1" },
      known: new Set(["b1", "a1", "b2"]),
    });
    // No `changedPaths` call was even attempted — there is nothing to diff u2 against.
    expect(plan).toEqual({ commit: "b1", files: 0, whole: true, at: "u1" });
  });

  it("保留期把某一轮的快照清掉了，也退回整目录而不是报错", async () => {
    const messages = [turnMessage("u1", "一", "b1", "a1"), turnMessage("u2", "二", "b2", "a2")];
    const plan = await planRestore({
      repoPath: "/nonexistent",
      thread: threadOf(messages),
      target: { messageId: "u1" },
      // `a2` is gone.
      known: new Set(["b1", "a1", "b2"]),
    });
    expect(plan.whole).toBe(true);
  });

  it("没恢复过就没有「回到最新」，快照不在本线程里也不给", async () => {
    const messages = [turnMessage("u1", "一", "b1", "a1")];
    await expect(
      planRestore({ repoPath: "/nonexistent", thread: threadOf(messages), target: { latest: true }, known: new Set(["b1"]) }),
    ).rejects.toThrow(/没有可回到的状态/);
    await expect(
      planRestore({ repoPath: "/nonexistent", thread: threadOf(messages), target: { messageId: "u1" }, known: new Set() }),
    ).rejects.toThrow(/快照已不存在/);
    await expect(
      planRestore({ repoPath: "/nonexistent", thread: threadOf(messages), target: { messageId: "nope" }, known: new Set(["b1"]) }),
    ).rejects.toThrow(/这条消息没有快照/);
  });

  it("恢复点的消息被压缩掉了，就按整目录处理", async () => {
    const messages = [turnMessage("u1", "一", "b1", "a1")];
    const plan = await planRestore({
      repoPath: "/nonexistent",
      thread: threadOf(messages, { messageId: "没了", undoCommit: "u" }),
      target: { messageId: "u1" },
      known: new Set(["b1", "a1"]),
    });
    expect(plan.whole).toBe(true);
  });

  it("「上一轮」要有两轮，而且最后一轮跑完了", () => {
    expect(lastTurnPair([turnMessage("u1", "一", "b1", "a1")])).toBeUndefined();
    expect(lastTurnPair([turnMessage("u1", "一", "b1", "a1"), turnMessage("u2", "二", "b2")])).toBeUndefined();
    expect(lastTurnPair([turnMessage("u1", "一", "b1", "a1"), turnMessage("u2", "二", "b2", "a2")])).toEqual({ from: "b2", to: "a2" });
  });

  it("给模型的那句话里带着被恢复的那条消息", () => {
    const note = restoreNote([turnMessage("u1", "把登录页重写一遍\n再说", "b1", "a1")], "u1");
    expect(note).toContain("把登录页重写一遍");
    expect(note).not.toContain("再说");
    expect(restoreNote([], "u1")).toContain("更早的一条消息");
  });
});

// --- the routes -----------------------------------------------------------

const auth = { authorization: `Bearer ${TOKEN}` };

function request(app: VgentApp, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...auth, ...(init?.body != null ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
}

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });

async function drain(response: Response): Promise<void> {
  await response.text();
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

const toStream = (parts: TextStreamPart<ToolSet>[]) =>
  ReadableStream.from(
    (async function* () {
      for (const part of parts) yield part;
    })(),
  ) as ReadableStream<TextStreamPart<ToolSet>>;

const TOOL_CALL = {
  type: "tool-call" as const,
  toolCallId: "call-1",
  toolName: "bash",
  input: { command: "true" },
  providerExecuted: true,
};

const textParts = (text: string): TextStreamPart<ToolSet>[] => [
  { type: "start" },
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", text },
  { type: "text-end", id: "t1" },
];

/**
 * Asks for approval on any prompt containing 「工具」 and answers with plain text
 * otherwise — the smallest engine that can park a turn, which is what makes an
 * approval continuation testable.
 */
function approvalEngine(): EngineFactoryOverride {
  return {
    async create() {
      let unfinished = false;
      const runner: EngineRunner = {
        hasUnfinishedTurn: () => unfinished,
        async stream({ messages }) {
          const last = messages.at(-1);
          if (last?.role === "tool") {
            unfinished = false;
            return {
              stream: toStream([
                { type: "start" },
                { ...TOOL_CALL, type: "tool-result", output: { ok: true } },
                ...textParts("跑完了").slice(1),
              ] as unknown as TextStreamPart<ToolSet>[]),
            };
          }
          const wantsTool = JSON.stringify(last).includes("工具");
          unfinished = wantsTool;
          return {
            stream: toStream(
              wantsTool
                ? ([
                    { type: "start" },
                    TOOL_CALL,
                    { type: "tool-approval-request", approvalId: "ap-1", toolCall: TOOL_CALL },
                  ] as unknown as TextStreamPart<ToolSet>[])
                : textParts("普通回答"),
            ),
          };
        },
        async finish() {},
        async destroy() {},
      };
      return runner;
    },
  };
}

/**
 * An engine that really writes to the working directory while its turn runs,
 * which is the only way to exercise 「这一轮动过哪些文件」 without a real one.
 * The prompt is the script: `写 <路径>=<内容>` and `删 <路径>`, one per line.
 *
 * `seen` collects every converted history it was handed, so a test can check
 * what actually reached the model.
 */
function editingEngine(seen?: ModelMessage[][]): EngineFactoryOverride {
  return {
    async create(ctx) {
      const runner: EngineRunner = {
        hasUnfinishedTurn: () => false,
        async stream({ messages }) {
          seen?.push(messages);
          const last = messages.at(-1);
          const text =
            typeof last?.content === "string"
              ? last.content
              : (last?.content ?? []).map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
          for (const line of text.split("\n")) {
            const write = /^写 (\S+)=(.*)$/.exec(line.trim());
            if (write?.[1] != null) await writeFile(join(ctx.project.repoPath, write[1]), `${write[2] ?? ""}\n`);
            const remove = /^删 (\S+)$/.exec(line.trim());
            if (remove?.[1] != null) await rm(join(ctx.project.repoPath, remove[1]), { force: true });
          }
          return { stream: toStream(textParts("好了")) };
        },
        async finish() {},
        async destroy() {},
      };
      return runner;
    },
  };
}

function makeApp(dataDir: string, engine: EngineFactoryOverride = approvalEngine()): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN, registry: createEngineRegistry({ "claude-code": engine }) });
  apps.push(instance);
  return instance;
}

async function setupThread(app: VgentApp, repoPath: string): Promise<ThreadRecord> {
  const project = (await (await postJson(app, "/api/projects", { repoPath })).json()) as Project;
  return (await (
    await postJson(app, "/api/threads", { projectId: project.id, title: "快照", engine: "claude-code" })
  ).json()) as ThreadRecord;
}

async function getThread(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  return (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
}

const checkpointOf = (message: UIMessage | undefined) => (message?.metadata as ThreadMessageMetadata | undefined)?.checkpoint;

async function waitForStatus(app: VgentApp, threadId: string, wanted: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await getThread(app, threadId);
    if (record.status === wanted) return record;
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 没有进入状态 ${wanted}`);
}

/** Waits until the run slot is free, so the next request is not a 409. */
async function waitForSlotReleased(app: VgentApp, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await request(app, `/api/chat/${threadId}/stream`);
    await response.body?.cancel();
    if (response.status === 204) return;
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 的运行槽位没有释放`);
}

/**
 * Waits until the turn's after-snapshot has been stamped. The run slot opens
 * first on purpose — the status the user watches must not wait on a snapshot —
 * so 「回合真的结束了」 is this, not a free slot.
 */
async function waitForTurnEnd(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  await waitForSlotReleased(app, threadId);
  for (let attempt = 0; attempt < 200; attempt++) {
    const record = await getThread(app, threadId);
    const last = [...record.messages].reverse().find((message) => message.role === "user");
    if ((last?.metadata as ThreadMessageMetadata | undefined)?.checkpointAfter != null) return record;
    await sleep(10);
  }
  throw new Error(`线程 ${threadId} 的回合结束快照没有出现`);
}

const restore = (app: VgentApp, threadId: string, body: unknown) =>
  postJson(app, `/api/threads/${threadId}/checkpoints/restore`, body);

const preview = (app: VgentApp, threadId: string, query: string) =>
  request(app, `/api/threads/${threadId}/checkpoints/preview?${query}`);

interface RestoreBody {
  restored: string;
  undo: string;
  files: number;
  whole: boolean;
  restoredTo?: { messageId: string };
}

/** Sends one turn and waits for it to really be over. */
async function runTurn(app: VgentApp, thread: ThreadRecord, message: UIMessage): Promise<ThreadRecord> {
  const history = (await getThread(app, thread.id)).messages;
  await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [...history, message] }));
  return waitForTurnEnd(app, thread.id);
}

describe.skipIf(!hasGit)("checkpoint 路由", () => {
  it("用户消息起的回合才打快照，审批续跑不打", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");
    expect(checkpointOf(parked.messages[0])).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // The first turn of a main-checkout task also pins its 任务基线, which is a
    // ref of its own rather than a numbered checkpoint.
    expect(await refNames(repo, thread.id)).toEqual([
      `${checkpointRefPrefix(thread.id)}/000001`,
      `${checkpointRefPrefix(thread.id)}/base`,
    ]);

    const pending = parked.messages.at(-1)!;
    const approved = {
      ...pending,
      parts: pending.parts.map((part) =>
        isToolUIPart(part) && part.state === "approval-requested"
          ? { ...part, state: "approval-responded", approval: { ...part.approval, approved: true } }
          : part,
      ),
    } as UIMessage;
    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [...parked.messages.slice(0, -1), approved] }));
    await waitForTurnEnd(app, thread.id);

    // The continuation belongs to the turn the first message already snapshotted:
    // it opened no new counter, and the turn's end snapshot rode on the old one.
    expect(await refNames(repo, thread.id)).toEqual([
      `${checkpointRefPrefix(thread.id)}/000001`,
      `${checkpointRefPrefix(thread.id)}/after-000001`,
      `${checkpointRefPrefix(thread.id)}/base`,
    ]);
  });

  it("项目不是 git 仓库：回合照跑，只是没有快照", async () => {
    const plain = await tempDir();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, plain);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "你好")] }));
    await waitForSlotReleased(app, thread.id);
    const done = await getThread(app, thread.id);
    expect(done.status).toBe("idle");
    expect(checkpointOf(done.messages[0])).toBeUndefined();
    expect((await restore(app, thread.id, { messageId: "u1" })).status).toBe(404);
  });

  it("只回退任务动过的文件；你自己改的别的文件原地不动，消息一条都不少", async () => {
    const repo = await repoWithHistory();
    // A dirty checkout, the way a real one is: an unstaged edit of the user's
    // own, a file they staged by hand, and an untracked file.
    await writeFile(join(repo, "tracked.txt"), "我自己改的\n");
    await writeFile(join(repo, "手工暂存.txt"), "用户自己 add 的\n");
    await git(repo, "add", "手工暂存.txt");
    await writeFile(join(repo, "未跟踪.txt"), "我自己建的\n");
    const cachedBefore = (await git(repo, "diff", "--cached")).stdout;
    expect(cachedBefore).not.toBe("");

    const app = makeApp(await tempDir(), editingEngine());
    const thread = await setupThread(app, repo);

    await runTurn(app, thread, userMessage("u1", "第一轮\n写 a.txt=one"));
    await runTurn(app, thread, userMessage("u2", "第二轮\n写 a.txt=two\n写 b.txt=第二轮建的"));

    // After both turns the user goes on working on their own files — one the
    // task never touched, and one it did.
    await writeFile(join(repo, "未跟踪.txt"), "两轮之后我又改的\n");
    await writeFile(join(repo, "a.txt"), "我手改了任务的文件\n");

    const restored = await restore(app, thread.id, { messageId: "u1" });
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as RestoreBody;
    expect(body.whole).toBe(false);
    expect(body.restoredTo?.messageId).toBe("u1");
    expect(body.restored).toBe(checkpointOf((await getThread(app, thread.id)).messages.find((m) => m.id === "u1"))?.commit);

    // The two files the task created are gone …
    expect(await missing(repo, "a.txt")).toBe(true);
    expect(await missing(repo, "b.txt")).toBe(true);
    // … and everything that was the user's own is exactly as they left it.
    expect(await read(repo, "未跟踪.txt")).toBe("两轮之后我又改的\n");
    expect(await read(repo, "tracked.txt")).toBe("我自己改的\n");
    expect(await read(repo, "ignored.txt")).toBe("别动我\n");
    expect((await git(repo, "diff", "--cached")).stdout).toBe(cachedBefore);
    expect(await read(repo, "手工暂存.txt")).toBe("用户自己 add 的\n");

    // 回到最新 puts both turns' files back and ends the stretch.
    const latest = await restore(app, thread.id, { latest: true });
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as RestoreBody).restoredTo).toBeUndefined();
    expect(await read(repo, "a.txt")).toBe("我手改了任务的文件\n");
    expect(await read(repo, "b.txt")).toBe("第二轮建的\n");
    expect(await read(repo, "未跟踪.txt")).toBe("两轮之后我又改的\n");
    expect((await getThread(app, thread.id)).restoredTo).toBeUndefined();

    // Nothing was deleted from the log on the way: both turns are still there.
    const after = await getThread(app, thread.id);
    expect(after.messages.filter((message) => message.role === "user").map((message) => message.id)).toEqual(["u1", "u2"]);
    expect((await git(repo, "diff", "--cached")).stdout).toBe(cachedBefore);
  });

  it("往回退一轮，再往前走一轮；「恢复到此处」两个方向是同一条路", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir(), editingEngine());
    const thread = await setupThread(app, repo);

    await runTurn(app, thread, userMessage("u1", "第一轮\n写 a.txt=one"));
    await runTurn(app, thread, userMessage("u2", "第二轮\n写 b.txt=two"));
    await runTurn(app, thread, userMessage("u3", "第三轮\n写 c.txt=three"));

    // All the way back to before the first turn.
    expect((await restore(app, thread.id, { messageId: "u1" })).status).toBe(200);
    expect(await missing(repo, "a.txt")).toBe(true);
    expect(await missing(repo, "b.txt")).toBe(true);
    expect(await missing(repo, "c.txt")).toBe(true);
    expect((await getThread(app, thread.id)).restoredTo?.messageId).toBe("u1");

    // Forward to before the third: turns one and two are back, three is not.
    const forward = await restore(app, thread.id, { messageId: "u3" });
    expect(forward.status).toBe(200);
    expect((await forward.json()) as RestoreBody).toMatchObject({ whole: false, restoredTo: { messageId: "u3" } });
    expect(await read(repo, "a.txt")).toBe("one\n");
    expect(await read(repo, "b.txt")).toBe("two\n");
    expect(await missing(repo, "c.txt")).toBe(true);

    // 回到最新 still means the state from before the *first* restore.
    expect((await restore(app, thread.id, { latest: true })).status).toBe(200);
    expect(await read(repo, "c.txt")).toBe("three\n");
    // And with the marker gone there is nothing left to go back to.
    const again = await restore(app, thread.id, { latest: true });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("not_restored");
  });

  it("恢复前先问会动几个文件，答案和真的动的一致", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir(), editingEngine());
    const thread = await setupThread(app, repo);

    await runTurn(app, thread, userMessage("u1", "第一轮\n写 a.txt=one"));
    await runTurn(app, thread, userMessage("u2", "第二轮\n写 b.txt=two\n写 a.txt=改了"));

    const asked = (await (await preview(app, thread.id, "messageId=u2")).json()) as { files: number; whole: boolean };
    // Turn two touched two files, and nothing else moves.
    expect(asked).toEqual({ files: 2, whole: false });
    const body = (await (await restore(app, thread.id, { messageId: "u2" })).json()) as RestoreBody;
    expect(body.files).toBe(2);
    expect(await read(repo, "a.txt")).toBe("one\n");
    expect(await missing(repo, "b.txt")).toBe(true);
  });

  it("恢复之后再发消息：恢复标记清掉，模型只被告知一次", async () => {
    const repo = await repoWithHistory();
    const seen: ModelMessage[][] = [];
    const app = makeApp(await tempDir(), editingEngine(seen));
    const thread = await setupThread(app, repo);

    await runTurn(app, thread, userMessage("u1", "第一轮\n写 a.txt=one"));
    await runTurn(app, thread, userMessage("u2", "第二轮\n写 b.txt=two"));
    expect((await restore(app, thread.id, { messageId: "u2" })).status).toBe(200);

    await runTurn(app, thread, userMessage("u3", "第三轮\n写 c.txt=three"));
    await runTurn(app, thread, userMessage("u4", "第四轮\n写 d.txt=four"));

    const prompts = seen.map((messages) => JSON.stringify(messages.at(-1)));
    expect(prompts).toHaveLength(4);
    expect(prompts.filter((text) => text.includes("已把工作目录恢复到"))).toHaveLength(1);
    expect(prompts[2]).toContain("已把工作目录恢复到");
    expect(prompts[2]).toContain("第二轮");
    // The stored conversation keeps the user's own words, note or no note.
    const record = await getThread(app, thread.id);
    expect(JSON.stringify(record.messages)).not.toContain("已把工作目录恢复到");
    expect(record.restoredTo).toBeUndefined();
  });

  it("「上一轮」看的是最后一轮两个快照之间的差别，不看工作目录", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir(), editingEngine());
    const thread = await setupThread(app, repo);

    // One turn is not enough for the scope to say anything new.
    await runTurn(app, thread, userMessage("u1", "第一轮\n写 a.txt=one"));
    expect(((await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as ChangesResponse).lastTurn).toBe(false);
    expect((await request(app, `/api/threads/${thread.id}/changes?scope=last-turn`)).status).toBe(404);

    await runTurn(app, thread, userMessage("u2", "第二轮\n写 b.txt=two\n删 a.txt"));
    // Something the user changed *after* the turn ended, which the scope must not see.
    await writeFile(join(repo, "我自己的.txt"), "跟上一轮无关\n");

    const all = (await (await request(app, `/api/threads/${thread.id}/changes`)).json()) as ChangesResponse;
    expect(all.lastTurn).toBe(true);
    expect(all.files.map((file) => file.path).sort()).toEqual(["b.txt", "我自己的.txt"]);

    const lastTurn = (await (await request(app, `/api/threads/${thread.id}/changes?scope=last-turn`)).json()) as ChangesResponse;
    expect(lastTurn.files.map((file) => ({ path: file.path, status: file.status })).sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: "a.txt", status: "deleted" },
      { path: "b.txt", status: "added" },
    ]);
    // The per-file diff follows the same scope.
    const diff = (await (await request(app, `/api/threads/${thread.id}/changes/file?path=b.txt&scope=last-turn`)).json()) as {
      diff: string;
    };
    expect(diff.diff).toContain("+two");
  });

  it("运行中不给恢复，不属于本线程的 commit 也不给", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下")] }));
    await waitForStatus(app, thread.id, "awaiting-approval");
    const blocked = await restore(app, thread.id, { messageId: "u1" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("thread_running");
  });

  it("只接受 messageId 或 latest 其一，别的消息一律 404", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForSlotReleased(app, thread.id);

    expect((await restore(app, thread.id, {})).status).toBe(400);
    expect((await restore(app, thread.id, { messageId: "u1", latest: true })).status).toBe(400);
    const unknown = await restore(app, thread.id, { messageId: "没这条" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("checkpoint_not_found");
  });

  it("删除任务时连它的快照引用一起清掉", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForTurnEnd(app, thread.id);
    // The turn's two checkpoints and the 任务基线 ref.
    expect(await refNames(repo, thread.id)).toHaveLength(3);

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await refNames(repo, thread.id)).toEqual([]);
  });
}, 30_000);
