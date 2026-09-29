import type { AccountId, EngineId, ModelEntry, UsageWindow } from "@/lib/types";

/**
 * The login a task's tokens are drawn from, read off the model row that runs
 * it: a Claude or Codex subscription, or the GitHub account behind Copilot.
 * A provider's key or a gateway has no quota to show and gets none. With no
 * row to read (a harness left to pick its own default) it is the engine's own
 * login.
 */
export function accountOf(entry: Pick<ModelEntry, "source"> | undefined, engine: EngineId): AccountId | undefined {
  const source = entry?.source;
  if (source?.kind === "claude-subscription") return "claude";
  if (source?.kind === "codex-subscription") return "codex";
  if (source?.kind === "provider" && source.id === "github-copilot") return "github";
  if (source != null) return undefined;
  return engine === "claude-code" ? "claude" : engine === "codex" ? "codex" : undefined;
}

/** The windows that can run out — an unlimited one never will — with the fullest first. */
export function meteredWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return windows
    .filter((window) => window.unlimited !== true && window.usedPercent != null)
    .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0));
}
