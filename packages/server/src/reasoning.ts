import { CLAUDE_CODE_EFFORTS } from "@vgent/engines";

/**
 * 推理强度 a task runs with when it names none: 高, on every engine. A coding
 * task is worth the thinking, and one default across engines means the chip in
 * the composer never has to explain why the same word means different things.
 */
export const DEFAULT_REASONING_LEVEL = "high";

/**
 * 「不指定」: the task sends no effort at all and the provider decides. Only
 * offered where a model may refuse the parameter outright — a settings-page
 * provider's model on the in-house engine, about which nothing is known — so
 * there is always a way out of a level the endpoint rejects.
 */
export const PROVIDER_DEFAULT_LEVEL = "provider-default";

/** The level a task really runs with: its own choice, or the default. */
export const effectiveReasoningLevel = (level: string | undefined): string => level ?? DEFAULT_REASONING_LEVEL;

/**
 * What the catalog reports as a model's default. 高 wherever the model offers
 * it; a model that does not keeps whatever its own source declared, so the
 * picker never marks a level the model cannot run.
 */
export function defaultLevelFor(levels: readonly string[], declared: string | undefined): string | undefined {
  if (levels.includes(DEFAULT_REASONING_LEVEL)) return DEFAULT_REASONING_LEVEL;
  return declared != null && levels.includes(declared) ? declared : undefined;
}

type ReasoningEngine = "claude-code" | "codex" | "vgent" | "opencode";

/**
 * What each engine can *carry* to the model. Claude Code's `effort` and Codex's
 * `model_reasoning_effort` are harness settings; the in-house engine sends the
 * AI SDK's portable `reasoning`, which has no `max`.
 */
const CARRIED_LEVELS: Record<ReasoningEngine, readonly string[]> = {
  "claude-code": CLAUDE_CODE_EFFORTS,
  codex: ["low", "medium", "high", "xhigh", "max"],
  vgent: ["none", "minimal", "low", "medium", "high", "xhigh"],
  // OpenCode's variant names: it derives the set per model and ignores one the model lacks.
  opencode: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** What is offered for a model nobody knows anything about. */
const UNKNOWN_MODEL_LEVELS: Record<ReasoningEngine, readonly string[]> = {
  "claude-code": CLAUDE_CODE_EFFORTS,
  codex: ["low", "medium", "high", "xhigh"],
  vgent: [PROVIDER_DEFAULT_LEVEL, "low", "medium", "high"],
  opencode: [PROVIDER_DEFAULT_LEVEL, "low", "medium", "high"],
};

/**
 * 推理强度 for a model that arrives without a catalog row of its own to declare
 * it — a settings-page provider's model, a Claude Code model. One function for
 * every such door into the picker, so a model can no longer show up without its
 * levels (or with somebody else's) just because of the way it came in.
 *
 * `known` is what the provider catalog lists for this very model (see
 * `createReasoningIndex`): models differ — Opus 4.5 stops at 高, DeepSeek V4 Pro
 * has only 高 and 最高, Haiku has no knob at all — so that list is the answer,
 * cut down to what the engine can carry. An empty result means no chip. Only a
 * model the catalog has never heard of gets the engine's generic set, and on the
 * in-house engine that set includes 「不指定」, the way out when an endpoint
 * refuses the parameter.
 */
export function reasoningFor(
  engine: ReasoningEngine,
  known: readonly string[] | undefined,
): { reasoningLevels?: string[]; defaultReasoningLevel?: string } {
  const levels = known == null ? [...UNKNOWN_MODEL_LEVELS[engine]] : known.filter((level) => CARRIED_LEVELS[engine].includes(level));
  if (levels.length === 0) return {};
  // 高 where the model has it; otherwise the most it offers.
  return { reasoningLevels: levels, defaultReasoningLevel: defaultLevelFor(levels, levels.at(-1)) as string };
}
