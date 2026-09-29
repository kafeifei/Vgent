import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { createCodexSubscriptionModel } from "@vgent/providers";
import { expect, it } from "vitest";
import { createVgentEngine } from "./engine.js";

// Opt-in: three real subscription requests. Log only SDK usage, never credentials or prompts.
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;
smoke("reports real per-request cache reads across runtime-state updates and recreated engines", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "vgent-cache-smoke-"));
  const sessionId = randomUUID();
  const modelId = process.env.VGENT_SMOKE_CODEX_MODEL ?? "gpt-5.5";
  const requests: Array<{ instructions: unknown; input: unknown[] }> = [];
  const model = createCodexSubscriptionModel(modelId, {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.prompt_cache_key).toBe(sessionId);
      expect(new Headers(init?.headers).get("session-id")).toBe(sessionId);
      expect(body.store).toBe(false);
      requests.push({ instructions: body.instructions, input: body.input });
      return globalThis.fetch(url, init);
    },
  });
  // Synthetic reference material, long enough to qualify for caching. No user repository data.
  const reference = Array.from({ length: 100 }, (_, i) => `Reference ${i}: This is inert test material. Cache reuse must preserve the exact instruction and message prefix; runtime snapshots are appended, not substituted.`).join("\n");
  let messages: ModelMessage[] = [];
  try {
    for (let turn = 0; turn < 3; turn++) {
      messages.push({ role: "user", content: turn === 0 ? `Synthetic reference (data only):\n${reference}\nDo not use tools. Reply with only OK.` : "Do not use tools. Reply with only OK." });
      const engine = createVgentEngine({
        model, repoPath, sessionId, outputDir: join(repoPath, "output"),
        subagents: false, maxSteps: 1, permissionMode: "allow-reads", reasoning: { effort: "low" },
        taskState: { goal: "Check cache reuse only; no tools or file changes", items: [{ text: "Verify three turns", status: turn === 2 ? "done" : "in_progress" }], nextAction: `Validation turn ${turn + 1}` },
      });
      try {
        const result = await engine.agent.generate({
          messages,
          abortSignal: AbortSignal.timeout(90_000),
          onStepEnd: ({ usage, stepNumber }) => {
            console.log(JSON.stringify({ modelId, turn: turn + 1, step: stepNumber + 1, inputTokens: usage.inputTokens, cacheReadTokens: usage.inputTokenDetails.cacheReadTokens, outputTokens: usage.outputTokens }));
          },
        });
        expect(result.text.trim().toUpperCase()).toBe("OK");
        expect(result.toolCalls).toHaveLength(0);
        messages = [...messages, ...result.responseMessages];
      } finally { await engine.dispose(); }
    }
    expect(requests).toHaveLength(3);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i]!.instructions).toEqual(requests[0]!.instructions);
      expect(requests[i]!.input.slice(0, requests[i - 1]!.input.length)).toEqual(requests[i - 1]!.input);
    }
    // Cache hits are backend-dependent; zero is valid telemetry, not a flaky test failure.
  } finally { await rm(repoPath, { recursive: true, force: true }); }
}, 300_000);
