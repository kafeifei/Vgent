import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenCodeEngine, openCodeAuthContent } from "./opencode.js";

/**
 * Runs the real OpenCode runtime on the caller's own Codex (ChatGPT) login,
 * handed over as OpenCode's login store. Off by default: it costs requests and
 * the first bootstrap installs the bridge with pnpm.
 */
const hasCodexLogin = await access(join(homedir(), ".codex", "auth.json"))
  .then(() => true)
  .catch(() => false);

const smoke = process.env.VGENT_SMOKE === "1" && hasCodexLogin ? it : it.skip;
const model = `openai/${process.env.VGENT_SMOKE_CODEX_MODEL ?? "gpt-5.5"}`;

async function repo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "vgent-smoke-opencode-"));
  await writeFile(join(repoPath, "hello-vgent.txt"), "hello from vgent\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repoPath });
  return repoPath;
}

/** The login as `codex login` stored it. The server refreshes it first; a smoke run just needs a fresh one. */
async function codexLogin(): Promise<{ accessToken: string; accountId?: string }> {
  const auth = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8")) as { tokens?: { access_token?: string; account_id?: string } };
  const accessToken = auth.tokens?.access_token;
  if (accessToken == null) throw new Error("~/.codex/auth.json has no ChatGPT login");
  return { accessToken, ...(auth.tokens?.account_id != null ? { accountId: auth.tokens.account_id } : {}) };
}

async function engineFor(repoPath: string, permissionMode: "allow-all" | "allow-reads") {
  const login = await codexLogin();
  return createOpenCodeEngine({
    repoPath,
    permissionMode,
    model,
    env: { OPENCODE_AUTH_CONTENT: openCodeAuthContent(login) },
    dataDir: process.env.VGENT_SMOKE_DATA_DIR ?? join(tmpdir(), "vgent-smoke-opencode-data"),
  });
}

describe("createOpenCodeEngine (smoke)", () => {
  if (process.env.VGENT_SMOKE === "1" && !hasCodexLogin) {
    console.warn("[smoke] skipping createOpenCodeEngine smoke test: ~/.codex/auth.json not found (no Codex login on this machine).");
  }

  smoke(
    "answers a question about the repository it was pointed at",
    async () => {
      const engine = await engineFor(await repo(), "allow-all");
      try {
        const result = await engine.agent.generate({
          prompt: "Read the file hello-vgent.txt in this repository and reply with only its exact contents.",
        });
        expect(result.text).toContain("hello from vgent");
        const usage = result.totalUsage;
        expect(usage.inputTokens).toBeGreaterThan(0);
        expect(usage.inputTokens).toBe(
          (usage.inputTokenDetails.noCacheTokens ?? 0) +
          (usage.inputTokenDetails.cacheReadTokens ?? 0) +
          (usage.inputTokenDetails.cacheWriteTokens ?? 0),
        );
        expect(usage.raw?.vgentInputTokensIncludeCache).toBe(true);
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );

  smoke(
    "asks before an edit, names the call it asks about, and carries on once approved",
    async () => {
      const repoPath = await repo();
      const engine = await engineFor(repoPath, "allow-reads");
      try {
        const first = await engine.harnessAgent.stream({
          session: engine.session,
          messages: [{ role: "user", content: "Create a file named world.txt containing exactly the word world." }],
          options: undefined,
        });
        const calls = new Set<string>();
        let approval: { approvalId: string; toolCallId: string } | undefined;
        for await (const part of first.stream) {
          if (part.type === "tool-call") calls.add(part.toolCallId);
          if (part.type === "tool-approval-request") approval = { approvalId: part.approvalId, toolCallId: part.toolCall.toolCallId };
          if (part.type === "error") throw part.error;
        }
        expect(approval).toBeDefined();
        // The bridge patch: the call is out before the request that names it.
        expect(calls.has(approval!.toolCallId)).toBe(true);

        const second = await engine.harnessAgent.continueStream({
          session: engine.session,
          toolApprovalContinuations: [{ type: "tool-approval-response", approvalId: approval!.approvalId, approved: true }],
        });
        for await (const part of second.stream) if (part.type === "error") throw part.error;
        expect((await readFile(join(repoPath, "world.txt"), "utf8")).trim()).toBe("world");
      } finally {
        await engine.dispose();
      }
    },
    15 * 60_000,
  );
});
