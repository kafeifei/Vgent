import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SlashCommand } from "./slash";

/**
 * The `/` menu: rows under small grey headings, the row that is in force ticked,
 * and on each row its name and the way to type it — nothing else. No sentence
 * says what a row does or why another is missing; a row that cannot be run is
 * not in the list (see `SlashCommand`).
 */
export function SlashMenu({
  rows,
  active,
  onRun,
  onHover,
}: {
  rows: readonly SlashCommand[];
  active: number;
  onRun: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 z-10 mb-2xs max-h-[calc(var(--spacing-xl)*10)] w-full overflow-y-auto rounded-xl border border-border bg-bg-elevated p-2xs shadow-lg">
      {rows.map((command, index) => (
        <div key={command.id}>
          {command.section !== rows[index - 1]?.section && <div className="px-xs pt-2xs pb-3xs text-fg-faint text-xs">{command.section}</div>}
          <button
            type="button"
            // `mousedown`, so the textarea never loses focus to the click.
            onMouseDown={(event) => {
              event.preventDefault();
              onRun(command);
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              "flex min-h-row w-full items-center gap-xs rounded-md px-xs text-left text-body",
              index === active ? "bg-bg-active" : "hover:bg-bg-hover",
            )}
          >
            <span className="min-w-0 flex-1 truncate text-fg">{command.label}</span>
            {command.selected === true && <Check className="size-md flex-none text-fg-muted" />}
            <span className="flex-none font-mono text-fg-faint text-xs">/{command.id}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
