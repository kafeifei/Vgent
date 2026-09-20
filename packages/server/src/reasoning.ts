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

/**
 * The levels a settings-page provider's model offers. Such a model comes with no
 * catalog row to declare them, so they follow from *how the engine carries the
 * effort* rather than from the model: Claude Code's `effort` and Codex's
 * `model_reasoning_effort` are harness settings that apply to whatever model
 * runs; the in-house engine sends the AI SDK's portable `reasoning`, of which
 * low / medium / high are the ones every package maps without coercion.
 *
 * One function for all three engines, called where provider models join the
 * catalog, so a model can no longer reach the picker without its levels just
 * because it came in by a different door.
 */
export function providerModelReasoning(engine: "claude-code" | "codex" | "vgent"): {
  reasoningLevels: string[];
  defaultReasoningLevel: string;
} {
  const levels =
    engine === "claude-code"
      ? [...CLAUDE_CODE_EFFORTS]
      : engine === "codex"
        ? ["low", "medium", "high", "xhigh"]
        : [PROVIDER_DEFAULT_LEVEL, "low", "medium", "high"];
  return { reasoningLevels: levels, defaultReasoningLevel: DEFAULT_REASONING_LEVEL };
}
