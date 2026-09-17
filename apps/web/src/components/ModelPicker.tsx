import type { ReactNode } from "react";
import { PopItem, PopTitle, Popover } from "./Popover";

/** Static list until the server exposes a model registry. `null` = 默认. */
export const MODELS: ReadonlyArray<{ id: string | null; label: string }> = [
  { id: null, label: "默认" },
  { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
  { id: "claude-opus-4-1", label: "claude-opus-4-1" },
];

export const modelLabel = (model: string | undefined): string => model ?? "默认";

export function ModelPicker({
  model,
  onPick,
  trigger,
  align = "start",
  side = "bottom",
}: {
  model: string | undefined;
  onPick: (model: string | null) => void;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  return (
    <Popover align={align} side={side} trigger={trigger}>
      {(close) => (
        <>
          <PopTitle>模型</PopTitle>
          {MODELS.map((entry) => (
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
