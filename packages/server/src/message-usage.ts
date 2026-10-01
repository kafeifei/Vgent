import type { LanguageModelUsage, UIMessage } from "ai";
import type { EngineId, ThreadMessageMetadata, UsageInfo } from "./types.js";

/** OpenCode's old adapter stored only fresh input in the field for the full prompt. */
function repairOpenCodeUsage(usage: UsageInfo): UsageInfo {
  if (usage.inputTokensIncludeCache === true) return usage;
  const cached = (usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    ...usage,
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens + cached } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens + cached } : {}),
    inputTokensIncludeCache: true,
  };
}

/** v7 usage → persisted counts. Also accepts a continuation from a pre-fix OpenCode bridge. */
export function toUsageInfo(usage: LanguageModelUsage, engine: EngineId, inputTokensIncludeCache = usage.raw?.vgentInputTokensIncludeCache === true): UsageInfo {
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  const reasoning = usage.outputTokenDetails?.reasoningTokens;
  const info: UsageInfo = {
    ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens } : {}),
    ...(cached != null ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning != null ? { reasoningTokens: reasoning } : {}),
  };
  // The pinned bridge patch marks both steps and totals. An already-running
  // bridge can still be attached after an upgrade and speaks the old shape.
  return engine === "opencode" && !inputTokensIncludeCache
    ? repairOpenCodeUsage(info)
    : { ...info, inputTokensIncludeCache: true };
}

/** Two normalized counts added field by field; unreported fields stay absent. */
export function addUsageInfo(a: UsageInfo, b: UsageInfo): UsageInfo {
  const sum: UsageInfo = { inputTokensIncludeCache: true };
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (a[key] != null || b[key] != null) sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return sum;
}

/**
 * Read-repair old counts, including copied fork history. The user message's
 * run identifies the engine that produced each answer; the current thread's
 * engine is only a fallback. Mark each usage independently so partial stream
 * metadata and subsequent reads/writes cannot add the cache twice.
 */
export function repairMessageUsage(messages: UIMessage[], engine: EngineId): UIMessage[] {
  let turnEngine = engine;
  return messages.map((message) => {
    const metadata = message.metadata as ThreadMessageMetadata | undefined;
    if (metadata?.run != null) turnEngine = metadata.run.engine;
    if (message.role !== "assistant" || turnEngine !== "opencode" || metadata == null) return message;
    const usage = metadata.usage == null ? undefined : repairOpenCodeUsage(metadata.usage);
    const totalUsage = metadata.totalUsage == null ? undefined : repairOpenCodeUsage(metadata.totalUsage);
    if (usage === metadata.usage && totalUsage === metadata.totalUsage) return message;
    return { ...message, metadata: {
      ...metadata,
      ...(usage != null ? { usage } : {}),
      ...(totalUsage != null ? { totalUsage } : {}),
    } };
  });
}
