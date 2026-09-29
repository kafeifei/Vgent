import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToModelMessages, readUIMessageStream, tool, type ModelMessage, type UIMessage } from "ai";
import { z } from "zod";
import { createCodexSubscriptionModel } from "@vgent/providers";
import { expect, it } from "vitest";
import { createVgentEngine } from "./engine.js";

// Opt-in real subscription requests. Log SDK usage/structural checks, never credentials or prompts.
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

// Real streaming search → local tool → dependent local tool → answer, then UI-persisted replay.
smoke("reports cache reads across hosted discovery, dependent tools and UI-persisted turns", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "vgent-search-cache-smoke-"));
  const sessionId = randomUUID();
  const modelId = process.env.VGENT_SMOKE_CODEX_MODEL ?? "gpt-5.5";
  type Item = Record<string, unknown>;
  const requests: Array<{ settings: Record<string, unknown>; input: Item[] }> = [];
  let turn = 0;
  const model = createCodexSubscriptionModel(modelId, {
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.prompt_cache_key).toBe(sessionId);
      expect(new Headers(init?.headers).get("session-id")).toBe(sessionId);
      expect(body.store).toBe(false);
      const { input, ...settings } = body;
      if (requests.length) expect(settings).toEqual(requests[0]!.settings);
      requests.push({ settings, input });
      return globalThis.fetch(url, init);
    },
  });
  const lookups: string[] = [];
  const confirmations: string[] = [];
  const codes = new Map<string, string>();
  const extraTools = {
    fixture__lookup_inventory: tool({
      description: "Look up a synthetic inventory record by its fixture name. Returns a one-time verification code. Use only these in-memory smoke test records.",
      inputSchema: z.object({ fixture: z.string() }), deferLoading: true,
      execute: async ({ fixture }) => {
        lookups.push(fixture);
        const code = randomUUID(); codes.set(code, fixture);
        return { fixture, code, next: "Call the synthetic checksum confirmation tool with this code before answering." };
      },
    }),
    fixture__confirm_checksum: tool({
      description: "Confirm the one-time verification code returned by the synthetic inventory lookup tool. Returns VERIFIED if the record was actually looked up.",
      inputSchema: z.object({ code: z.string() }), deferLoading: true,
      execute: async ({ code }) => {
        expect(codes.has(code)).toBe(true);
        confirmations.push(code);
        return { fixture: codes.get(code), status: "VERIFIED" };
      },
    }),
  };
  // An older Vgent session used generic search: the native provider must keep
  // these saved function records intact rather than reinterpret their schema.
  const history: UIMessage[] = [
    { id: "legacy-user", role: "user", parts: [{ type: "text", text: "Search for the obsolete synthetic fixture tool." }] },
    { id: "legacy-assistant", role: "assistant", parts: [{
      type: "tool-toolSearch", toolCallId: "call_legacy_search", state: "output-available",
      input: { query: "obsolete fixture" }, output: { tools: [{ name: "fixture__obsolete", description: "Obsolete synthetic fixture tool" }] },
    }] },
  ];
  try {
    for (turn = 1; turn <= 2; turn++) {
      history.push({ id: `user-${turn}`, role: "user", parts: [{ type: "text", text: `Use tool search to find the synthetic inventory lookup and checksum confirmation tools. Look up fixture-${turn}, then confirm the code returned by the lookup. Do not guess the code. Finally answer only VERIFIED. Do not use files, shell, or other tools.` }] });
      const engine = createVgentEngine({
        model, repoPath, sessionId, outputDir: join(repoPath, "output"), extraTools,
        subagents: false, maxSteps: 8, permissionMode: "allow-all", reasoning: { effort: "low" },
        taskState: { goal: "Verify in-memory synthetic records only", items: [{ text: "Verify fixtures", status: "in_progress" }], nextAction: `Check fixture-${turn}` },
      });
      try {
        const result = await engine.agent.stream({
          messages: await convertToModelMessages(history, { tools: engine.agent.tools }),
          abortSignal: AbortSignal.timeout(120_000),
          onStepEnd: ({ usage, stepNumber, toolCalls }) => {
            const current = requests.at(-1)!;
            const previous = requests.at(-2);
            console.log(JSON.stringify({ modelId, turn, step: stepNumber + 1, tools: toolCalls.map((call) => call.toolName), inputTokens: usage.inputTokens, cacheReadTokens: usage.inputTokenDetails.cacheReadTokens, outputTokens: usage.outputTokens,
              ...(previous ? { inputPrefixStable: JSON.stringify(current.input.slice(0, previous.input.length)) === JSON.stringify(previous.input) } : {}),
            }));
          },
        });
        let saved: UIMessage | undefined;
        for await (const message of readUIMessageStream({ stream: result.toUIMessageStream({ originalMessages: history }), terminateOnError: true })) saved = message;
        expect(saved?.parts.some((part) => part.type === "text" && part.text.includes("VERIFIED"))).toBe(true);
        history.push(JSON.parse(JSON.stringify(saved)) as UIMessage);
      } finally { await engine.dispose(); }
    }
    expect(lookups).toEqual(["fixture-1", "fixture-2"]);
    expect(confirmations).toHaveLength(2);
    expect(requests.length).toBeGreaterThanOrEqual(6);
    expect(requests[0]!.settings.tools).toContainEqual(expect.objectContaining({ type: "tool_search" }));
    expect(requests.some((request) => request.input.some((item) => item.type === "tool_search_output"))).toBe(true);
    for (let i = 1; i < requests.length; i++) {
      const current = requests[i]!; const previous = requests[i - 1]!;
      expect(current.settings).toEqual(requests[0]!.settings);
      expect(current.input.slice(0, previous.input.length)).toEqual(previous.input);
    }
    // Usage is observed, not asserted: backend cache eviction can still yield zero hits.
  } finally { await rm(repoPath, { recursive: true, force: true }); }
}, 300_000);
