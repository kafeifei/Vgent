import type { ReactNode } from "react";
import type { EngineId, ModelEntry } from "@/lib/types";
import { useModelCatalog } from "./ModelPicker";
import { PopItem, PopTitle, Popover } from "./Popover";

/**
 * The level names every engine speaks, in Chinese. `low`/`medium`/`high`/
 * `xhigh` come from the OpenAI side (Codex's own catalog and the gateway),
 * `disabled`/`adaptive`/`enabled` from the Claude Code harness's `thinking`
 * setting. A level nobody here knows shows its raw id rather than nothing.
 */
const LEVEL_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极致",
  none: "关",
  minimal: "极低",
  disabled: "关",
  adaptive: "自适应",
  enabled: "开",
};

export const reasoningLabel = (level: string): string => LEVEL_LABELS[level] ?? level;

/**
 * The levels to show when no model has been picked. If every model in the
 * engine's catalog offers the same ones — which is the case for Claude Code,
 * where「思考等级」is a harness setting rather than a model capability — then
 * whichever model the server falls back to offers them too. When the catalog
 * disagrees with itself there is nothing honest to show, so the chip stays
 * hidden until a model is named.
 */
function agreedLevels(entries: readonly ModelEntry[]): ModelEntry | undefined {
  const first = entries[0];
  if (first?.reasoningLevels == null) return undefined;
  const agreed = entries.every(
    (entry) =>
      entry.reasoningLevels?.join("\u0000") === first.reasoningLevels?.join("\u0000") &&
      entry.defaultReasoningLevel === first.defaultReasoningLevel,
  );
  return agreed ? first : undefined;
}

/**
 * 「思考 ▾」— the levels the *selected model* declares, straight from the model
 * catalog. Renders nothing when that model has none, so an engine or a model
 * without a reasoning knob never shows a dead chip.
 *
 * `model` is what the task picked; when it picked nothing, the catalog's own
 * `defaultModel` — which the server resolves per engine — is the model that
 * will really run, so it answers instead.
 */
export function ReasoningPicker({
  engine,
  model,
  level,
  onPick,
  trigger,
  align = "start",
  side = "bottom",
}: {
  engine: EngineId;
  model: string | undefined;
  /** The task's own choice; unset means the model's default. */
  level: string | undefined;
  onPick: (level: string) => void;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0], current: string) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const state = useModelCatalog(engine);
  const entries = state.status === "ready" ? state.catalog.models : [];
  const named = model ?? (state.status === "ready" ? state.catalog.defaultModel : undefined);
  const entry = named == null ? agreedLevels(entries) : entries.find((candidate) => candidate.id === named);
  const levels = entry?.reasoningLevels ?? [];
  const current = level ?? entry?.defaultReasoningLevel;
  if (levels.length === 0 || current == null) return null;

  return (
    <Popover align={align} side={side} trigger={(props) => trigger(props, reasoningLabel(current))}>
      {(close) => (
        <>
          <PopTitle>思考等级</PopTitle>
          {levels.map((option) => (
            <PopItem
              key={option}
              selected={option === current}
              onClick={() => {
                onPick(option);
                close();
              }}
            >
              {reasoningLabel(option)}
              <span className="ml-2xs font-mono text-2xs text-fg-faint">{option}</span>
            </PopItem>
          ))}
        </>
      )}
    </Popover>
  );
}
