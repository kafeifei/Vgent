import { useMemo } from "react";
import type { UIMessage } from "ai";
import { DEFAULT_CONTEXT_WINDOW, contextUsage, formatTokens } from "./contextUsage";

/** Geometry of the 16px ring (`--spacing-ring`), in its own 16×16 viewBox. */
const RADIUS = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Past this share of the window the ring turns to the warning token. */
const WARN_AT = 0.8;

/**
 * Context window occupancy, as the small ring at the right end of the review
 * bar. Cursor's equivalent: one glance says whether the task is close to
 * needing a /compact, and the tooltip carries the actual numbers.
 *
 * `contextWindow` comes from the model catalog the composer's `ModelPicker`
 * already fetched; without one the ring measures against
 * `DEFAULT_CONTEXT_WINDOW` and the tooltip admits it.
 */
export function ContextRing({ messages, contextWindow }: { messages: readonly UIMessage[]; contextWindow?: number }) {
  const usage = useMemo(() => contextUsage(messages), [messages]);
  // Not named `window`: that would shadow the global one in a browser module.
  const limit = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ratio = Math.min(1, Math.max(0, usage.tokens / limit));

  const tip = [
    `上下文 ${formatTokens(usage.tokens)} / ${formatTokens(limit)}（${Math.round(ratio * 100)}%）`,
    usage.source === "estimate" ? "（估算）" : "",
    contextWindow == null ? `（窗口大小未知，按 ${formatTokens(DEFAULT_CONTEXT_WINDOW)} 计）` : "",
  ].join("");

  // The wrapper carries the label (and the native tooltip), so the svg inside
  // it is decorative.
  return (
    <span className="ml-auto inline-flex flex-none items-center" title={tip} role="img" aria-label={tip}>
      <svg viewBox="0 0 16 16" className="size-ring" aria-hidden="true">
        <circle cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2" className="stroke-border" />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform="rotate(-90 8 8)"
          className={ratio >= WARN_AT ? "stroke-warning" : "stroke-fg-muted"}
        />
      </svg>
    </span>
  );
}
