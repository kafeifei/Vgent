import { useEffect, useState, type ReactNode } from "react";
import { createClient, getToken } from "@/lib/api";
import type { EngineId, ModelCatalog } from "@/lib/types";
import { PopItem, PopTitle, Popover } from "./Popover";

export const modelLabel = (model: string | undefined): string => model ?? "默认";

/** What the footer line says about where the list came from. */
const SOURCE_LABELS: Record<string, string> = {
  "codex-remote": "来自 Codex 在线目录",
  "codex-cache": "来自 Codex 缓存",
  gateway: "来自 AI Gateway",
  "anthropic-api": "来自 Anthropic API",
  builtin: "内置清单",
};

function describeSource(source: string): string {
  return source
    .split("+")
    .map((part) => SOURCE_LABELS[part] ?? part)
    .join(" + ");
}

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: ModelCatalog }
  | { status: "error"; message: string };

export function ModelPicker({
  engine,
  model,
  onPick,
  onCatalog,
  trigger,
  align = "start",
  side = "bottom",
}: {
  engine: EngineId;
  model: string | undefined;
  onPick: (model: string | null) => void;
  /**
   * The loaded catalog, handed up so a sibling can read a model's metadata
   * (the composer's context ring wants `contextWindow`) off the list this
   * picker has already fetched instead of fetching it again.
   */
  onCatalog?: (catalog: ModelCatalog) => void;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const [state, setState] = useState<CatalogState>({ status: "loading" });

  // One load per engine. The server caches each catalog for ten minutes, so
  // remounting the picker costs nothing worth debouncing. `onCatalog` is
  // deliberately not a dependency: it is an output, and refetching whenever the
  // parent hands down a new closure is exactly what this effect must not do.
  useEffect(() => {
    const token = getToken();
    if (token == null) return;
    let cancelled = false;
    setState({ status: "loading" });
    createClient(token)
      .listModels(engine)
      .then(
        (catalog) => {
          if (cancelled) return;
          setState({ status: "ready", catalog });
          onCatalog?.(catalog);
        },
        (error: unknown) => {
          if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [engine]);

  const entries = state.status === "ready" ? state.catalog.models : [];
  // A thread can carry a model the catalog no longer lists (another machine, an
  // older list). Losing the ability to see it would be worse than an odd row.
  const orphan = model != null && !entries.some((entry) => entry.id === model) ? model : undefined;
  const footer =
    state.status === "error"
      ? `模型列表加载失败：${state.message}`
      : state.status === "ready"
        ? (state.catalog.warning ?? describeSource(state.catalog.source))
        : undefined;

  return (
    <Popover align={align} side={side} trigger={trigger}>
      {(close) => (
        <>
          <PopTitle>模型</PopTitle>
          <PopItem
            selected={model === undefined}
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            <span className="font-mono">默认</span>
          </PopItem>
          {orphan != null && (
            <PopItem selected onClick={close}>
              <span className="font-mono">当前：{orphan}</span>
            </PopItem>
          )}
          {state.status === "loading" && <PopItem disabled>加载中…</PopItem>}
          {entries.map((entry) => (
            <PopItem
              key={entry.id}
              selected={entry.id === model}
              onClick={() => {
                onPick(entry.id);
                close();
              }}
            >
              <span className="font-mono">{entry.label}</span>
            </PopItem>
          ))}
          {footer != null && <div className="px-xs py-2xs text-2xs text-fg-faint">{footer}</div>}
        </>
      )}
    </Popover>
  );
}
