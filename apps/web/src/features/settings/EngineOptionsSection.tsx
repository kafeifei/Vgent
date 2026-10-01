import { useState } from "react";
import type { ApiClient } from "@/lib/api";
import { useToast } from "@/lib/toast";
import type { EngineDescriptor, EngineId, EngineOptionKey, EngineOptions, Settings, WebSearchMode } from "@/lib/types";
import { Segmented, SettingsGroup, SettingsRow, Switch } from "./layout";

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
 * 引擎选项: per engine, the switches that change what its model can do. Each
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
    <>
      {engines
        .filter((engine) => engine.options != null && Object.keys(engine.options).length > 0)
        .map((engine) => (
          <SettingsGroup key={engine.id} title={engine.label}>
            {ROWS.filter((row) => row.key in engine.options!).map((row) => {
              const value = engineOptionValue(engine, settings.engineOptions, row.key);
              const busy = pending === `${engine.id}:${row.key}`;
              return (
                <SettingsRow key={row.key} title={row.title}>
                  {row.key === "webSearch" ? (
                    <Segmented
                      label={`${engine.label} ${row.title}`}
                      value={(value as WebSearchMode | undefined) ?? "cached"}
                      options={WEB_SEARCH_MODES}
                      onChange={(next) => set(engine.id, row.key, next)}
                    />
                  ) : (
                    <Switch
                      checked={value === true}
                      onChange={(next) => set(engine.id, row.key, next)}
                      label={`${engine.label} ${row.title}`}
                      disabled={busy}
                    />
                  )}
                </SettingsRow>
              );
            })}
          </SettingsGroup>
        ))}
    </>
  );
}
