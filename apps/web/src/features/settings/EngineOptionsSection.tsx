import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { PopItem, Popover, PopTitle } from "@/components/Popover";
import type { ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, EngineOptionKey, EngineOptions, Settings, WebSearchMode } from "@/lib/types";
import { SettingsGroup } from "./layout";

/** In this order, and only the ones an engine has (its descriptor's `options`). */
const ROWS: ReadonlyArray<{ key: EngineOptionKey; title: string }> = [
  { key: "subagents", title: "子代理" },
  { key: "memory", title: "记忆" },
  { key: "todos", title: "待办" },
  { key: "web", title: "联网" },
  { key: "webSearch", title: "联网搜索" },
  { key: "lsp", title: "LSP 诊断" },
];

const WEB_SEARCH_MODES: ReadonlyArray<{ id: WebSearchMode; label: string }> = [
  { id: "live", label: "实时" },
  { id: "cached", label: "缓存" },
  { id: "disabled", label: "关" },
];

/** One engine's value for a key: what the user set, else the engine's default. */
export function engineOptionValue(
  engine: EngineDescriptor,
  stored: Settings["engineOptions"],
  key: EngineOptionKey,
): EngineOptions[EngineOptionKey] {
  return stored?.[engine.id]?.[key] ?? engine.options?.[key];
}

/**
 * 引擎选项: per engine, the choices that change what its model can do. Each
 * engine lists only what it really has; a change saves at once and the next
 * turn runs with it.
 */
export function EngineOptionsSection({
  engines,
  settings,
  client,
  onSaved,
}: {
  engines: readonly EngineDescriptor[];
  settings: Settings;
  client: ApiClient;
  onSaved: (settings: Settings) => void;
}) {
  const toast = useToast();
  /** `<engine>:<key>` while its save is in flight. */
  const [pending, setPending] = useState<string | null>(null);

  const set = (engine: EngineId, key: EngineOptionKey, value: boolean | WebSearchMode): void => {
    setPending(`${engine}:${key}`);
    client
      .putEngineOption(engine, key, value)
      .then(onSaved, (error: Error) => toast(error.message))
      .finally(() => setPending(null));
  };

  return (
    <SettingsGroup title="引擎选项" note="修改后下一轮生效。">
      {engines
        .filter((engine) => engine.options != null && Object.keys(engine.options).length > 0)
        .map((engine) => {
          const rows = ROWS.filter((row) => row.key in engine.options!);
          const enabled = rows.flatMap((row) => {
            const value = engineOptionValue(engine, settings.engineOptions, row.key);
            if (row.key === "webSearch" && value !== "disabled") {
              const mode = WEB_SEARCH_MODES.find((entry) => entry.id === value)?.label ?? "缓存";
              return [`${row.title}（${mode}）`];
            }
            return value === true ? [row.title] : [];
          });
          return (
            <div key={engine.id}>
              <Popover
                ariaLabel={`${engine.label} 选项`}
                trigger={(props) => (
                  <button {...props} type="button" aria-label={`${engine.label} 选项`}
                    className="flex min-h-[calc(var(--spacing-row)*1.5)] w-full items-center gap-md px-md py-sm text-left hover:bg-bg-hover aria-expanded:bg-bg-active">
                    <span className="flex-none text-fg text-md">{engine.label}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-fg-muted text-sm">{enabled.join("、") || "全部关闭"}</span>
                    <ChevronDown aria-hidden className="size-md flex-none text-fg-faint" />
                  </button>
                )}
              >
                {() => rows.map((row) => {
                  const value = engineOptionValue(engine, settings.engineOptions, row.key);
                  const busy = pending === `${engine.id}:${row.key}`;
                  return row.key === "webSearch" ? (
                    <div key={row.key} role="group" aria-label={row.title} className="mt-2xs border-t border-border pt-2xs">
                      <PopTitle>{row.title}</PopTitle>
                      {WEB_SEARCH_MODES.map((mode) => (
                        <PopItem key={mode.id} role="menuitemradio" checked={value === mode.id} disabled={busy}
                          onClick={() => set(engine.id, row.key, mode.id)}>
                          {mode.label}
                        </PopItem>
                      ))}
                    </div>
                  ) : (
                    <PopItem key={row.key} role="menuitemcheckbox" checked={value === true} disabled={busy}
                      onClick={() => set(engine.id, row.key, value !== true)}>
                      {row.title}
                    </PopItem>
                  );
                })}
              </Popover>
            </div>
          );
        })}
    </SettingsGroup>
  );
}
