import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isToolUIPart, type TextStreamPart, type ToolSet, type UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import {
  CHECKPOINT_RETENTION,
  checkpointRefPrefix,
  createCheckpoint,
  deleteCheckpoints,
  restoreCheckpoint,
  snapshotTree,
} from "./checkpoints.js";
import { createEngineRegistry, type EngineFactoryOverride, type EngineRunner } from "./engines/registry.js";
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

  it(`只保留最新的 ${CHECKPOINT_RETENTION} 条引用，删除任务时全部清掉`, async () => {
    const repo = await repoWithHistory();
    for (let i = 0; i < CHECKPOINT_RETENTION + 5; i += 1) {
      await writeFile(join(repo, "tracked.txt"), `第 ${i} 轮\n`);
      expect(await createCheckpoint({ repoPath: repo, threadId: "t1" })).toBeDefined();
    }
    const kept = await refNames(repo, "t1");
    expect(kept).toHaveLength(CHECKPOINT_RETENTION);
    expect(kept.at(0)).toBe(`${checkpointRefPrefix("t1")}/000006`);
    expect(kept.at(-1)).toBe(`${checkpointRefPrefix("t1")}/000055`);

    expect(await deleteCheckpoints({ repoPath: repo, threadId: "t1" })).toBe(CHECKPOINT_RETENTION);
    expect(await refNames(repo, "t1")).toEqual([]);
  }, 60_000);
}, 30_000);

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

function makeApp(dataDir: string): VgentApp {
  const instance = createApp({ dataDir, token: TOKEN, registry: createEngineRegistry({ "claude-code": approvalEngine() }) });
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

const restore = (app: VgentApp, threadId: string, body: unknown) =>
  postJson(app, `/api/threads/${threadId}/checkpoints/restore`, body);

describe.skipIf(!hasGit)("checkpoint 路由", () => {
  it("用户消息起的回合才打快照，审批续跑不打", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "用工具跑一下")] }));
    const parked = await waitForStatus(app, thread.id, "awaiting-approval");
    expect(checkpointOf(parked.messages[0])).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await refNames(repo, thread.id)).toHaveLength(1);

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
    await waitForSlotReleased(app, thread.id);

    // The continuation belongs to the turn the first message already snapshotted.
    expect(await refNames(repo, thread.id)).toHaveLength(1);
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

  it("恢复到某条消息之前，再撤销回去；消息一条都不少", async () => {
    const repo = await repoWithHistory();
    // Something staged by hand, so「不碰真实索引」has a witness.
    await writeFile(join(repo, "手工暂存.txt"), "用户自己 add 的\n");
    await git(repo, "add", "手工暂存.txt");
    const cachedBefore = (await git(repo, "diff", "--cached", "--name-only")).stdout;
    expect(cachedBefore).not.toBe("");
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForSlotReleased(app, thread.id);
    // The engine's work for turn one.
    await writeFile(join(repo, "a.txt"), "one\n");

    const first = await getThread(app, thread.id);
    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [...first.messages, userMessage("u2", "第二轮")] }));
    await waitForSlotReleased(app, thread.id);
    // The engine's work for turn two.
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "b.txt"), "第二轮建的\n");

    const restored = (await restore(app, thread.id, { messageId: "u2" })) as Response;
    expect(restored.status).toBe(200);
    const body = (await restored.json()) as { restored: string; undo: string; changeStats?: { files: number } };
    expect(body.restored).toBe(checkpointOf((await getThread(app, thread.id)).messages.find((m) => m.id === "u2"))?.commit);
    expect(await read(repo, "a.txt")).toBe("one\n");
    expect(await missing(repo, "b.txt")).toBe(true);
    expect(await read(repo, "ignored.txt")).toBe("别动我\n");

    // 撤销 puts back exactly what the restore replaced.
    const undone = await restore(app, thread.id, { commit: body.undo });
    expect(undone.status).toBe(200);
    expect(await read(repo, "a.txt")).toBe("two\n");
    expect(await read(repo, "b.txt")).toBe("第二轮建的\n");

    // All the way back to before the first turn.
    expect((await restore(app, thread.id, { messageId: "u1" })).status).toBe(200);
    expect(await missing(repo, "a.txt")).toBe(true);
    expect(await missing(repo, "b.txt")).toBe(true);

    // Nothing was deleted from the log on the way: both turns are still there.
    const after = await getThread(app, thread.id);
    expect(after.messages.filter((message) => message.role === "user").map((message) => message.id)).toEqual(["u1", "u2"]);
    // Only the working tree moved: the user's own index is exactly as they left it.
    expect((await git(repo, "diff", "--cached", "--name-only")).stdout).toBe(cachedBefore);
    expect(await read(repo, "手工暂存.txt")).toBe("用户自己 add 的\n");
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

  it("只接受 messageId 或 commit 其一，且 commit 必须在本线程的快照里", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForSlotReleased(app, thread.id);

    expect((await restore(app, thread.id, {})).status).toBe(400);
    expect((await restore(app, thread.id, { messageId: "u1", commit: "deadbeef" })).status).toBe(400);
    // A real commit of this very repo, but not one of our checkpoints.
    const head = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    const foreign = await restore(app, thread.id, { commit: head });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("checkpoint_not_found");
  });

  it("删除任务时连它的快照引用一起清掉", async () => {
    const repo = await repoWithHistory();
    const app = makeApp(await tempDir());
    const thread = await setupThread(app, repo);

    await drain(await postJson(app, `/api/chat/${thread.id}`, { messages: [userMessage("u1", "第一轮")] }));
    await waitForSlotReleased(app, thread.id);
    expect(await refNames(repo, thread.id)).toHaveLength(1);

    expect((await request(app, `/api/threads/${thread.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await refNames(repo, thread.id)).toEqual([]);
  });
}, 30_000);
