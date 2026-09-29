import { useMemo, type ReactNode } from "react";
import type { UIMessage } from "ai";
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Progress } from "@/components/ui/progress";
import type { ModelCost } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DEFAULT_CONTEXT_WINDOW, contextUsage, formatTokens, taskUsage, usageCost } from "./contextUsage";

/** Past this share of the window the ring turns to the warning token. */
const WARN_AT = 0.8;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Context window occupancy at the right end of the review bar, as AI Elements'
 * `Context`: the ring and its percentage say at a glance whether the task is
 * close to needing a /compact; hovering opens the card with the numbers — how
 * full the window is, then what the task has used so far and, when the model
 * has a list price, what that would cost on the API.
 *
 * The element's own rows and footer price through tokenlens, whose bundled
 * price table stops at 2025-10 and knows none of the models Vgent runs; they
 * are given their contents here instead, priced from the models.dev catalog
 * the server attaches to the model (`cost`).
 *
 * `contextWindow` comes from the model catalog the composer's `ModelPicker`
 * already fetched; without one the ring measures against
 * `DEFAULT_CONTEXT_WINDOW`, and the card marks the share as approximate — as it
 * does when no engine reported the prompt size and it had to be estimated.
 */
export function ContextRing({
  messages,
  contextWindow,
  contextOptions,
  cost,
}: {
  messages: readonly UIMessage[];
  contextWindow?: number | undefined;
  /** The windows the model can run with, smallest first — the fallback when `contextWindow` is unknown. */
  contextOptions?: readonly number[] | undefined;
  cost?: ModelCost | undefined;
}) {
  const context = useMemo(() => contextUsage(messages), [messages]);
  const total = useMemo(() => taskUsage(messages), [messages]);
  // Not named `window`: that would shadow the global one in a browser module.
  // Unknown, it is the smallest window the model is offered with that still
  // holds what was measured: a prompt bigger than the default proves the
  // default wrong (Claude Code runs Opus 5.5 past 200k with no [1m] asked).
  const limit =
    contextWindow ??
    contextOptions?.find((option) => option >= context.tokens) ??
    Math.max(DEFAULT_CONTEXT_WINDOW, ...(contextOptions ?? []));
  const ratio = Math.min(1, Math.max(0, context.tokens / limit));
  const approximate = context.source === "estimate" || contextWindow == null;
  const price = total != null && cost != null ? usageCost(total, cost) : undefined;
  const reasoning = total?.outputTokenDetails.reasoningTokens ?? 0;
  const cacheRead = total?.inputTokenDetails.cacheReadTokens ?? 0;

  return (
    <Context usedTokens={Math.min(context.tokens, limit)} maxTokens={limit} {...(total != null ? { usage: total } : {})}>
      <ContextTrigger
        variant="ghost"
        size="sm"
        aria-label={`上下文 ${approximate ? "≈" : ""}${Math.round(ratio * 100)}%`}
        className={cn(
          "ml-auto h-xl gap-2xs px-2xs font-normal has-[>svg]:px-2xs",
          ratio >= WARN_AT ? "text-warning hover:text-warning" : "text-fg-muted hover:text-fg",
        )}
      />
      <ContextContent side="top" align="end" className="w-64 divide-border border-0 bg-bg-elevated shadow-popover">
        <ContextContentHeader>
          <div className="flex items-center justify-between gap-md text-xs">
            <span className="text-fg">
              {approximate ? "≈" : ""}
              {Math.round(ratio * 100)}%
            </span>
            <span className="font-mono text-fg-muted">
              {formatTokens(context.tokens)} / {formatTokens(limit)}
            </span>
          </div>
          <Progress className="h-2xs bg-bg-strong" value={ratio * 100} />
        </ContextContentHeader>
        {total != null && (
          <ContextContentBody className="space-y-2xs">
            <p className="text-2xs text-fg-faint">累计</p>
            <Row label="输入" tokens={total.inputTokens ?? 0} note={price != null ? usd.format(price.input) : undefined} />
            {cacheRead > 0 && (
              <Row label="缓存命中" tokens={cacheRead} note={`${Math.round((cacheRead / Math.max(1, total.inputTokens ?? 0)) * 100)}%`} />
            )}
            <Row label="输出" tokens={total.outputTokens ?? 0} note={price != null ? usd.format(price.output) : undefined} />
            {reasoning > 0 && <Row label="思考" tokens={reasoning} />}
          </ContextContentBody>
        )}
        {price != null && (
          <ContextContentFooter className="bg-bg-inset">
            <span className="text-fg-muted">折合 API 价</span>
            <span className="text-fg">{usd.format(price.total)}</span>
          </ContextContentFooter>
        )}
      </ContextContent>
    </Context>
  );
}

/** One line of the card's body, in the element's own layout: label left, count right, then a muted note. */
function Row({ label, tokens, note }: { label: string; tokens: number; note?: ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-fg-muted">{label}</span>
      <span className="text-fg">
        {formatTokens(tokens)}
        {note != null && <span className="ml-xs text-fg-muted">• {note}</span>}
      </span>
    </div>
  );
}
