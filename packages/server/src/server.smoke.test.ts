import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, type VgentApp } from "./app.js";
import type { HarnessState, Project, ThreadRecord } from "./types.js";
import { consoleLogger } from "./types.js";

/**
 * Drives the real Claude Code engine through the HTTP surface, using the
 * caller's own login. Off by default: it costs requests and the first bootstrap
 * installs the bridge with pnpm, which takes minutes.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;

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

describe("@vgent/server (smoke)", () => {
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
          await postJson(appA, "/api/threads", { projectId: project.id, title: "冒烟", engine: "claude-code", permissionMode: "allow-reads" })
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
});
