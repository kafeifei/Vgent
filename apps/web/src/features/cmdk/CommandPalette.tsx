import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { isImeKeyEvent } from "@/lib/ime";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K: one flat command list, ↑↓ to move, Enter to run, Esc to close. A modal
 * combobox: focus stays in the input (Tab does not leave it) and the list is
 * followed by `aria-activedescendant`; closing hands focus back to where it was.
 */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  // Read while rendering: `autoFocus` moves focus into the input before any effect runs.
  const [before] = useState(() => (typeof document === "undefined" ? null : document.activeElement));

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Back to where it was — the composer, usually — unless the command that was
  // run has already put focus somewhere of its own.
  useEffect(
    () => () => {
      if (before instanceof HTMLElement && (document.activeElement === document.body || document.activeElement == null)) before.focus();
    },
    [before],
  );

  const run = (command: Command | undefined) => {
    if (command == null) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="fixed inset-0 z-30 flex justify-center bg-bg-scrim pt-[calc(var(--spacing-3xl)*2)]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="flex h-fit max-h-[calc(var(--spacing-3xl)*8)] w-[calc(var(--spacing-log-max)*0.7)] max-w-[calc(100%-var(--spacing-xl))] flex-col overflow-hidden rounded-xl bg-bg-elevated shadow-lg ring-1 ring-border"
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={matches[cursor] != null ? optionId(cursor) : undefined}
          aria-label="命令"
          value={query}
          placeholder="输入命令或任务名…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isImeKeyEvent(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Tab") {
              // The input is the only stop; the page behind is not reachable while this is open.
              event.preventDefault();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(matches.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(matches[cursor]);
            }
          }}
          className="w-full border-border border-b bg-transparent px-lg py-md text-md outline-none placeholder:text-fg-faint"
        />
        <div ref={listRef} id={listId} role="listbox" aria-label="命令" className="overflow-y-auto p-2xs">
          {matches.length === 0 ? (
            <div className="p-lg text-center text-fg-faint text-sm">没有匹配的命令</div>
          ) : (
            matches.map((command, index) => (
              <button
                key={command.id}
                id={optionId(index)}
                type="button"
                role="option"
                aria-selected={index === cursor}
                tabIndex={-1}
                data-cursor={index === cursor}
                onPointerEnter={() => setCursor(index)}
                onClick={() => run(command)}
                className={cn(
                  "flex w-full items-center gap-xs rounded-sm px-xs py-2xs text-left text-fg-muted text-sm",
                  index === cursor && "bg-bg-active text-fg",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.hint != null && <span className="flex-none font-mono text-fg-faint text-xs">{command.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
