import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeSubscriptionAuth } from "@vgent/providers";
import { isToolUIPart, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import type { HarnessState, Project, ThreadRecord } from "./types.js";
import { consoleLogger } from "./types.js";

/**
 * Drives the real engines through the HTTP surface, using the caller's own
 * logins. Off by default: it costs requests and the first bootstrap installs
 * each bridge with pnpm, which takes minutes.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;

/**
 * The Codex harness and the in-house engine's default model both run on the
 * machine's ChatGPT / Codex login. Without one there is nothing to smoke-test,
 * so those two cases skip with a warning instead of failing.
 */
const hasCodexLogin = (await describeSubscriptionAuth()).codex.available;
const codexSmoke = process.env.VGENT_SMOKE === "1" && hasCodexLogin ? it : it.skip;

const TOKEN = "smoke-token";
const ORIGIN = "http://127.0.0.1:7412";
const REPO_PATH = resolve(import.meta.dirname, "../../..");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function request(app: VgentApp, path: string, init?: RequestInit): Promise<Response> {
  return app.app.request(`${ORIGIN}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.body != null ? { "content-type": "application/json" } : {}) },
  });
}

const postJson = (app: VgentApp, path: string, body: unknown) => request(app, path, { method: "POST", body: JSON.stringify(body) });

async function collectText(response: Response): Promise<string> {
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string; errorText?: string })
    .filter((chunk) => {
      if (chunk.type === "error") throw new Error(`流里出现错误: ${chunk.errorText}`);
      return chunk.type === "text-delta";
    })
    .map((chunk) => chunk.delta ?? "")
    .join("");
}

async function waitForIdle(app: VgentApp, threadId: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const record = (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
    if (record.status !== "running") return record;
    await sleep(500);
  }
  throw new Error("线程一直停在 running");
}

async function waitForHarnessFile(path: string): Promise<HarnessState> {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await stat(path).catch(() => undefined)) return JSON.parse(await readFile(path, "utf8")) as HarnessState;
    await sleep(500);
  }
  throw new Error(`harness 状态文件没有出现: ${path}`);
}

async function waitForStatus(app: VgentApp, threadId: string, wanted: string): Promise<ThreadRecord> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const record = (await (await request(app, `/api/threads/${threadId}`)).json()) as ThreadRecord;
    if (record.status === wanted) return record;
    if (record.status === "error") throw new Error(`线程进入 error: ${record.error}`);
    await sleep(500);
  }
  throw new Error(`线程没有进入状态 ${wanted}`);
}

/** Answers a pending approval the way `useChat`'s `addToolApprovalResponse` does. */
function approve(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      isToolUIPart(part) && part.state === "approval-requested"
        ? { ...part, state: "approval-responded", approval: { ...part.approval, approved: true } }
        : part,
    ),
  } as UIMessage;
}

/** A throwaway git repo for an engine that is about to write into it. */
async function tempRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "vgent-smoke-repo-"));
  await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repoPath });
  return repoPath;
}

describe("@vgent/server (smoke)", () => {
  if (process.env.VGENT_SMOKE === "1" && !hasCodexLogin) {
    console.warn("[smoke] 跳过 Codex / vgent 冒烟：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）。");
  }

  smoke(
    "runs a turn on the Claude Code engine and resumes it after a simulated restart",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "vgent-server-smoke-"));
      const harnessPath = join(dataDir, "threads");

      const appA = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      let threadId: string;
      let firstReply: string;
      try {
        const project = (await (await postJson(appA, "/api/projects", { repoPath: REPO_PATH })).json()) as Project;
        const thread = (await (
          await postJson(appA, "/api/threads", { projectId: project.id, title: "冒烟", engine: "claude-code" })
        ).json()) as ThreadRecord;
        threadId = thread.id;

        const response = await postJson(appA, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "用一句话说明这个仓库是做什么的，不要调用工具" }] }],
        });
        expect(response.status).toBe(200);
        firstReply = await collectText(response);
        console.log(`[smoke] 第一轮回复: ${firstReply}`);
        expect(firstReply.trim().length).toBeGreaterThan(0);

        await waitForIdle(appA, threadId);
      } finally {
        await appA.shutdown();
      }

      const firstState = await waitForHarnessFile(join(harnessPath, `${threadId}.harness.json`));

      // A brand new app over the same data dir is what a server restart looks like.
      const appB = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      try {
        const restored = (await (await request(appB, `/api/threads/${threadId}`)).json()) as ThreadRecord;
        expect(restored.messages.length).toBeGreaterThanOrEqual(2);

        const response = await postJson(appB, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [...restored.messages, { id: "u2", role: "user", parts: [{ type: "text", text: "把你上一句话再重复一遍" }] }],
        });
        expect(response.status).toBe(200);
        const secondReply = await collectText(response);
        console.log(`[smoke] 第二轮回复: ${secondReply}`);
        expect(secondReply.trim().length).toBeGreaterThan(0);

        const final = await waitForIdle(appB, threadId);
        expect(final.status).toBe("idle");
        expect(final.messages.length).toBeGreaterThanOrEqual(4);
      } finally {
        await appB.shutdown();
      }

      const secondState = await waitForHarnessFile(join(harnessPath, `${threadId}.harness.json`));
      expect(secondState.sessionId).toBe(threadId);
      // The resume state was rewritten by the second turn, so the session really carried over.
      expect(secondState.updatedAt).not.toBe(firstState.updatedAt);

      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
    15 * 60 * 1000,
  );

  smoke(
    "freezes a Claude Code approval over a restart and finishes the turn afterwards",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "vgent-server-smoke-suspend-"));
      const repoPath = await tempRepo();
      const target = join(repoPath, "restart-probe.txt");
      const harnessFile = join(dataDir, "threads");

      const appA = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      let threadId: string;
      try {
        const project = (await (await postJson(appA, "/api/projects", { repoPath })).json()) as Project;
        const thread = (await (
          await postJson(appA, "/api/threads", {
            projectId: project.id,
            title: "重启续跑冒烟",
            engine: "claude-code",
          })
        ).json()) as ThreadRecord;
        threadId = thread.id;

        const response = await postJson(appA, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [
            {
              id: "u1",
              role: "user",
              parts: [{ type: "text", text: "用 Bash 工具执行这一条命令：date > restart-probe.txt。只执行这一条，不要做别的。" }],
            },
          ],
        });
        expect(response.status).toBe(200);
        await response.text();

        const parked = await waitForStatus(appA, threadId, "awaiting-approval");
        console.log(`[smoke][suspend] 停在审批，待批工具: ${parked.messages.at(-1)?.parts.filter(isToolUIPart).map((part) => part.type).join(", ")}`);
        expect(await stat(target).catch(() => undefined)).toBeUndefined();
      } finally {
        // A graceful shutdown must freeze the turn instead of killing it.
        await appA.shutdown();
      }

      const frozen = await waitForHarnessFile(join(harnessFile, `${threadId}.harness.json`));
      expect(frozen.continueFrom).toBeDefined();

      const appB = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      try {
        const restored = (await (await request(appB, `/api/threads/${threadId}`)).json()) as ThreadRecord;
        // The recovery pass left it alone: the bridge is still holding the turn.
        expect(restored.status).toBe("awaiting-approval");

        const approved = approve(restored.messages.at(-1)!);
        const response = await postJson(appB, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [...restored.messages.slice(0, -1), approved],
        });
        expect(response.status).toBe(200);
        await response.text();

        const done = await waitForStatus(appB, threadId, "idle");
        console.log(`[smoke][suspend] 审批后文件内容: ${JSON.stringify(await readFile(target, "utf8"))}`);
        expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
        expect(done.messages.length).toBeGreaterThanOrEqual(2);
      } finally {
        await appB.shutdown();
      }

      // The finished turn superseded the frozen one.
      const finished = JSON.parse(await readFile(join(harnessFile, `${threadId}.harness.json`), "utf8")) as HarnessState;
      expect(finished.resumeFrom).toBeDefined();
      expect(finished.continueFrom).toBeUndefined();

      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
      await rm(repoPath, { recursive: true, force: true, maxRetries: 5 });
    },
    15 * 60 * 1000,
  );

  codexSmoke(
    "runs a turn on the Codex engine and resumes it after a simulated restart",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "vgent-server-smoke-codex-"));
      const harnessPath = join(dataDir, "threads");

      const appA = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      let threadId: string;
      try {
        const project = (await (await postJson(appA, "/api/projects", { repoPath: REPO_PATH })).json()) as Project;
        const created = await postJson(appA, "/api/threads", {
          projectId: project.id,
          title: "Codex 冒烟",
          engine: "codex",
        });
        expect(created.status).toBe(200);
        threadId = ((await created.json()) as ThreadRecord).id;

        const response = await postJson(appA, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "用一句话说明这个仓库是做什么的，不要调用工具" }] }],
        });
        expect(response.status).toBe(200);
        const firstReply = await collectText(response);
        console.log(`[smoke][codex] 第一轮回复: ${firstReply}`);
        expect(firstReply.trim().length).toBeGreaterThan(0);

        await waitForIdle(appA, threadId);
      } finally {
        await appA.shutdown();
      }

      const firstState = await waitForHarnessFile(join(harnessPath, `${threadId}.harness.json`));
      expect(firstState.sessionId).toBe(threadId);

      const appB = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      try {
        const restored = (await (await request(appB, `/api/threads/${threadId}`)).json()) as ThreadRecord;
        expect(restored.messages.length).toBeGreaterThanOrEqual(2);

        const response = await postJson(appB, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [...restored.messages, { id: "u2", role: "user", parts: [{ type: "text", text: "把你上一句话再重复一遍" }] }],
        });
        expect(response.status).toBe(200);
        const secondReply = await collectText(response);
        console.log(`[smoke][codex] 第二轮回复: ${secondReply}`);
        expect(secondReply.trim().length).toBeGreaterThan(0);

        const final = await waitForIdle(appB, threadId);
        expect(final.status).toBe("idle");
        expect(final.messages.length).toBeGreaterThanOrEqual(4);
      } finally {
        await appB.shutdown();
      }

      const secondState = await waitForHarnessFile(join(harnessPath, `${threadId}.harness.json`));
      expect(secondState.updatedAt).not.toBe(firstState.updatedAt);

      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    },
    15 * 60 * 1000,
  );

  codexSmoke(
    "parks a vgent approval, survives a restart, and finishes the write afterwards",
    async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "vgent-server-smoke-vgent-"));
      const repoPath = await tempRepo();
      const target = join(repoPath, "SMOKE.txt");

      const appA = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      let threadId: string;
      let parked: ThreadRecord;
      try {
        const project = (await (await postJson(appA, "/api/projects", { repoPath })).json()) as Project;
        // No model: the factory falls back to `DEFAULT_VGENT_MODEL`.
        const created = await postJson(appA, "/api/threads", {
          projectId: project.id,
          title: "自研引擎冒烟",
          engine: "vgent"
        });
        expect(created.status).toBe(200);
        threadId = ((await created.json()) as ThreadRecord).id;

        const response = await postJson(appA, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [
            {
              id: "u1",
              role: "user",
              parts: [{ type: "text", text: "在仓库根目录用 write 工具新建 SMOKE.txt，内容就写 hello from vgent，写完直接结束。" }],
            },
          ],
        });
        expect(response.status).toBe(200);
        await response.text();

        // `allow-reads` gates `write`, so the turn has to stop and ask.
        parked = await waitForStatus(appA, threadId, "awaiting-approval");
        console.log(`[smoke][vgent] 停在审批，待批工具: ${parked.messages.at(-1)?.parts.filter(isToolUIPart).map((part) => part.type).join(", ")}`);
        expect(await stat(target).catch(() => undefined)).toBeUndefined();
      } finally {
        await appA.shutdown();
      }

      // The in-house engine is stateless, so the restart must leave the pending
      // approval answerable and must never have written harness resume state.
      expect(await stat(join(dataDir, "threads", `${threadId}.harness.json`)).catch(() => undefined)).toBeUndefined();

      const appB = createApp({ dataDir, token: TOKEN, log: consoleLogger });
      try {
        const restored = (await (await request(appB, `/api/threads/${threadId}`)).json()) as ThreadRecord;
        expect(restored.status).toBe("awaiting-approval");

        const approved = approve(restored.messages.at(-1)!);
        const response = await postJson(appB, `/api/chat/${threadId}`, {
          id: threadId,
          messages: [...restored.messages.slice(0, -1), approved],
        });
        expect(response.status).toBe(200);
        await response.text();

        const done = await waitForStatus(appB, threadId, "idle");
        console.log(`[smoke][vgent] 审批后文件内容: ${JSON.stringify(await readFile(target, "utf8"))}`);
        expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
        expect(done.messages.length).toBeGreaterThanOrEqual(2);
      } finally {
        await appB.shutdown();
      }

      expect(await stat(join(dataDir, "threads", `${threadId}.harness.json`)).catch(() => undefined)).toBeUndefined();

      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
      await rm(repoPath, { recursive: true, force: true, maxRetries: 5 });
    },
    15 * 60 * 1000,
  );
});
