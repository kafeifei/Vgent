/**
 * 推理强度 a task runs with when it names none: 高, on every engine. A coding
 * task is worth the thinking, and one default across engines means the chip in
 * the composer never has to explain why the same word means different things.
 */
export const DEFAULT_REASONING_LEVEL = "high";

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
