import type { ReactNode } from "react";
import type { EngineId } from "@/lib/types";
import { PopItem, PopTitle, Popover } from "./Popover";

type ModelEntry = { id: string | null; label: string };

/** Static per-engine lists until the server exposes a model registry. `null` = 默认. */
const MODELS_BY_ENGINE: Record<EngineId, ReadonlyArray<ModelEntry>> = {
  "claude-code": [
    { id: null, label: "默认" },
    { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
    { id: "claude-opus-4-1", label: "claude-opus-4-1" },
  ],
  codex: [{ id: null, label: "默认" }],
  vgent: [
    { id: null, label: "默认（codex-subscription:gpt-5.5）" },
    { id: "codex-subscription:gpt-5.5", label: "codex-subscription:gpt-5.5" },
  ],
};

export const modelLabel = (model: string | undefined): string => model ?? "默认";

export function ModelPicker({
  engine,
  model,
  onPick,
  trigger,
  align = "start",
  side = "bottom",
}: {
  engine: EngineId;
  model: string | undefined;
  onPick: (model: string | null) => void;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const entries = MODELS_BY_ENGINE[engine];
  return (
    <Popover align={align} side={side} trigger={trigger}>
      {(close) => (
        <>
          <PopTitle>模型</PopTitle>
          {entries.map((entry) => (
            <PopItem
              key={entry.label}
              selected={(entry.id ?? undefined) === model}
              onClick={() => {
                onPick(entry.id);
                close();
              }}
            >
              <span className="font-mono">{entry.label}</span>
            </PopItem>
          ))}
        </>
      )}
    </Popover>
  );
}
