/** Shared helper for capping tool output while keeping both ends of it. */
export interface TruncatedText {
  text: string;
  truncated: boolean;
}

/**
 * Truncates `text` to at most `maxChars`, keeping a head and a tail so the
 * model can see both where a command started and how it ended. A no-op when
 * `text` already fits.
 */
export function truncateKeepingEnds(text: string, maxChars: number): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false };
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.max(0, maxChars - headLen);
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  const omitted = text.length - headLen - tailLen;
  return {
    text: `${head}\n... [${omitted} characters truncated] ...\n${tail}`,
    truncated: true,
  };
}
