import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CHATGPT_CODEX_BASE_URL, getCodexTokenProvider } from "@vgent/providers";
import { DEFAULT_CODEX_DATA_DIR, type CodexAuthEnvironment } from "@vgent/engines";
import type { LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { CodexAppServer, type CodexNotification } from "./codex-app-server.js";
import type { EngineContext, EngineRunner } from "./registry.js";

type Part = TextStreamPart<ToolSet>;
type Obj = Record<string, unknown>;
const asObject = (value: unknown): Obj => value != null && typeof value === "object" ? value as Obj : {};
const asString = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Old harness sessions already contain the native Codex thread id. */
export function codexThreadIdOf(ctx: EngineContext): string | undefined {
  const saved = ctx.harnessState;
  if (saved?.codexThreadId != null) return saved.codexThreadId;
  const resume = asObject(saved?.resumeFrom);
  return asString(asObject(resume.data).threadId);
}

function lastUserText(messages: readonly ModelMessage[]): string {
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (last == null) throw new Error("Codex turn has no user message");
  if (typeof last.content === "string") return last.content;
  return last.content.map((part) => "text" in part && typeof part.text === "string" ? part.text : "").join("\n");
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Codex's `TokenUsageBreakdown` → v7 usage. OpenAI counts a cache hit inside
 * the input and the reasoning inside the output, which is v7's reading too, so
 * the numbers carry over as they are.
 */
function toUsage(raw: unknown): LanguageModelUsage {
  const breakdown = asObject(raw);
  const input = count(breakdown.inputTokens);
  const cacheRead = count(breakdown.cachedInputTokens);
  const output = count(breakdown.outputTokens);
  const reasoning = count(breakdown.reasoningOutputTokens);
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: Math.max(0, input - cacheRead), cacheReadTokens: cacheRead, cacheWriteTokens: count(breakdown.cacheWriteInputTokens) },
    outputTokens: output,
    outputTokenDetails: { textTokens: Math.max(0, output - reasoning), reasoningTokens: reasoning },
    totalTokens: count(breakdown.totalTokens) || input + output,
  };
}

function addUsage(a: LanguageModelUsage, b: LanguageModelUsage): LanguageModelUsage {
  const sum = (x: number | undefined, y: number | undefined) => (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sum(a.inputTokenDetails.noCacheTokens, b.inputTokenDetails.noCacheTokens),
      cacheReadTokens: sum(a.inputTokenDetails.cacheReadTokens, b.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: sum(a.inputTokenDetails.cacheWriteTokens, b.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: sum(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: sum(a.outputTokenDetails.textTokens, b.outputTokenDetails.textTokens),
      reasoningTokens: sum(a.outputTokenDetails.reasoningTokens, b.outputTokenDetails.reasoningTokens),
    },
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
}

/**
 * One model call of the turn, as the step the rest of the server counts and
 * takes usage from. Codex reports the call's tokens and nothing about its
 * timing, so the performance figures are zeros rather than guesses.
 */
function finishStep(usage: LanguageModelUsage, modelId: string): Part {
  return {
    type: "finish-step",
    response: { id: "", timestamp: new Date(), modelId },
    usage,
    performance: {
      effectiveOutputTokensPerSecond: 0,
      outputTokensPerSecond: undefined,
      inputTokensPerSecond: undefined,
      effectiveTotalTokensPerSecond: 0,
      stepTimeMs: 0,
      responseTimeMs: 0,
      timeToFirstOutputMs: undefined,
      toolExecutionMs: {},
    },
    finishReason: "stop",
    rawFinishReason: undefined,
    providerMetadata: undefined,
  };
}

function toolName(type: string): string {
  if (type === "commandExecution") return "Bash";
  if (type === "fileChange") return "Edit";
  if (type === "webSearch") return "Search";
  return type;
}

/** Native Codex app-server runner. Unlike `codex exec`, it owns `turn/steer`. */
export async function createNativeCodexRunner(
  ctx: EngineContext,
  options: { model?: string; effort?: string; serviceTier?: string; codexConfig?: Obj; auth?: CodexAuthEnvironment },
): Promise<EngineRunner> {
  const home = await mkdir(join(DEFAULT_CODEX_DATA_DIR, "codex-home"), { recursive: true }).then(() => join(DEFAULT_CODEX_DATA_DIR, "codex-home"));
  const credential = options.auth == null ? await getCodexTokenProvider().getAccessToken() : undefined;
  const baseUrl = options.auth?.OPENAI_BASE_URL ?? CHATGPT_CODEX_BASE_URL;
  const key = options.auth?.OPENAI_API_KEY ?? credential?.accessToken;
  if (key == null) throw new Error("Codex credential is unavailable");
  const provider = {
    name: "Vgent Codex",
    base_url: baseUrl,
    env_key: "CODEX_API_KEY",
    wire_api: "responses",
    supports_websockets: false,
    ...(credential?.accountId != null ? { http_headers: { "ChatGPT-Account-ID": credential.accountId } } : {}),
  };
  const config: Obj = {
    preferred_auth_method: "apikey",
    model_provider: "agent_bridge_openai",
    model_providers: { agent_bridge_openai: provider },
    ...options.codexConfig,
  };
  const server = new CodexAppServer({
    cwd: ctx.project.repoPath,
    env: { ...process.env, CODEX_HOME: home, CODEX_API_KEY: key },
  });
  let threadId: string;
  try {
    await server.initialize();
    const prior = codexThreadIdOf(ctx);
    const params: Obj = {
      cwd: ctx.project.repoPath,
      model: options.model ?? null,
      config,
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    };
    const result = prior == null
      ? await server.request("thread/start", params)
      : await server.request("thread/resume", { ...params, threadId: prior });
    threadId = asString(asObject(result.thread).id) ?? "";
    if (threadId === "") throw new Error("Codex app-server did not return a thread id");
    await ctx.saveHarnessState({ version: 1, sessionId: ctx.thread.id, codexThreadId: threadId, updatedAt: new Date().toISOString() });
  } catch (error) {
    await server.close();
    throw error;
  }

  let turnId: string | undefined;
  let ended = false;
  let emit: ((part: Part) => void) | undefined;
  let closeStream: (() => void) | undefined;
  let failStream: ((error: Error) => void) | undefined;
  const textOpen = new Set<string>();
  const reasoningOpen = new Set<string>();
  const toolOpen = new Map<string, { name: string; input: unknown }>();
  const textSeen = new Set<string>();
  let lastError: string | undefined;
  /** The turn's calls added up, for its `finish`. */
  let turnUsage: LanguageModelUsage | undefined;

  const handle = (event: CodexNotification): void => {
    const params = event.params;
    if (event.method === "process/exited") {
      failStream?.(new Error(asString(params.message) ?? "Codex app-server exited"));
      return;
    }
    if (asString(params.threadId) !== threadId || emit == null) return;
    const item = asObject(params.item);
    const id = asString(item.id) ?? asString(params.itemId);
    const type = asString(item.type);
    if (event.method === "turn/started" && turnId == null) {
      turnId = asString(asObject(params.turn).id);
      return;
    }
    // Sent after every model call: `last` is that call — its input is how full
    // the context is now — while `total` runs over the whole Codex thread, so
    // the turn's own sum is kept here from the `last`s.
    if (event.method === "thread/tokenUsage/updated") {
      if (turnId == null || asString(params.turnId) !== turnId) return;
      const usage = toUsage(asObject(params.tokenUsage).last);
      turnUsage = turnUsage == null ? usage : addUsage(turnUsage, usage);
      emit(finishStep(usage, options.model ?? ""));
      return;
    }
    if (event.method === "error") {
      lastError = asString(asObject(params.error).message) ?? asString(params.message) ?? "Codex 执行失败";
      return;
    }
    if (event.method === "item/started" && id != null && type != null) {
      if (type === "userMessage") {
        const clientId = asString(item.clientId);
        if (clientId != null) void ctx.steerApplied(clientId)
          .catch(error => ctx.log.warn(`保存 Codex 引导回执失败 (${clientId})`, error));
      } else if (type === "agentMessage") {
        textOpen.add(id);
        emit({ type: "text-start", id });
      } else if (type === "reasoning") {
        reasoningOpen.add(id);
        emit({ type: "reasoning-start", id });
      } else if (type === "commandExecution" || type === "fileChange" || type === "webSearch") {
        const name = toolName(type);
        const input = type === "commandExecution" ? { command: item.command, cwd: item.cwd } : type === "fileChange" ? { changes: item.changes } : { query: item.query };
        toolOpen.set(id, { name, input });
        emit({ type: "tool-input-start", id, toolName: name, dynamic: true });
        emit({ type: "tool-input-delta", id, delta: JSON.stringify(input) });
        emit({ type: "tool-input-end", id });
        emit({ type: "tool-call", toolCallId: id, toolName: name, input, dynamic: true, providerExecuted: true });
      }
      return;
    }
    if (event.method === "item/agentMessage/delta" && id != null) {
      if (!textOpen.has(id)) { textOpen.add(id); emit({ type: "text-start", id }); }
      const delta = asString(params.delta);
      if (delta != null) { textSeen.add(id); emit({ type: "text-delta", id, text: delta }); }
      return;
    }
    if (event.method === "item/reasoning/summaryTextDelta" && id != null) {
      if (!reasoningOpen.has(id)) { reasoningOpen.add(id); emit({ type: "reasoning-start", id }); }
      const delta = asString(params.delta);
      if (delta != null) emit({ type: "reasoning-delta", id, text: delta });
      return;
    }
    if (event.method === "item/completed" && id != null) {
      if (textOpen.delete(id)) {
        if (!textSeen.has(id) && asString(item.text)) emit({ type: "text-delta", id, text: String(item.text) });
        emit({ type: "text-end", id });
      }
      if (reasoningOpen.delete(id)) emit({ type: "reasoning-end", id });
      const tool = toolOpen.get(id);
      if (tool != null) {
        toolOpen.delete(id);
        const output = type === "commandExecution"
          ? { output: item.aggregatedOutput ?? "", exitCode: item.exitCode, durationMs: item.durationMs }
          : type === "fileChange" ? { changes: item.changes, status: item.status } : item;
        emit({ type: "tool-result", toolCallId: id, toolName: tool.name, input: tool.input, output, dynamic: true, providerExecuted: true });
      }
      return;
    }
    if (event.method === "turn/completed" && asString(asObject(params.turn).id) === turnId) {
      const status = asString(asObject(params.turn).status);
      for (const id of textOpen) emit({ type: "text-end", id });
      for (const id of reasoningOpen) emit({ type: "reasoning-end", id });
      textOpen.clear(); reasoningOpen.clear();
      if (status === "failed") failStream?.(new Error(lastError ?? "Codex 回合失败"));
      else {
        if (status === "completed" && turnUsage != null) emit({ type: "finish", finishReason: "stop", rawFinishReason: undefined, totalUsage: turnUsage });
        closeStream?.();
      }
    }
  };
  const unsubscribe = server.onNotification(handle);

  return {
    hasUnfinishedTurn: () => false,
    async stream({ messages, abortSignal }) {
      const stream = new ReadableStream<Part>({
        start(controller) {
          emit = (part) => controller.enqueue(part);
          closeStream = () => { if (emit != null) { emit = undefined; controller.close(); } };
          failStream = (error) => { if (emit != null) { emit = undefined; controller.error(error); } };
          controller.enqueue({ type: "start" });
        },
        cancel() { void server.close(); },
      });
      const onAbort = () => {
        if (turnId != null) void server.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => {});
        void server.close();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await server.request("turn/start", {
          threadId,
          input: [{ type: "text", text: lastUserText(messages) }],
          ...(options.model != null ? { model: options.model } : {}),
          ...(options.effort != null ? { effort: options.effort } : {}),
          ...(options.serviceTier != null ? { serviceTier: options.serviceTier } : {}),
        });
        turnId = asString(asObject(result.turn).id);
        if (turnId == null) throw new Error("Codex app-server did not return a turn id");
        if (abortSignal.aborted) onAbort();
        return { stream };
      } catch (error) {
        abortSignal.removeEventListener("abort", onAbort);
        unsubscribe();
        await server.close();
        throw error;
      }
    },
    async steer(text, messageId) {
      if (turnId == null || emit == null) throw new Error("Codex turn is no longer accepting guidance");
      await server.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text }],
        clientUserMessageId: messageId,
      }, 15_000);
    },
    async finish() {
      if (ended) return;
      ended = true;
      unsubscribe();
      await server.close();
    },
    async destroy() {
      if (ended) return;
      ended = true;
      unsubscribe();
      await server.close();
    },
  };
}
