import { useEffect, useRef, useState, type ReactNode } from "react";
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

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: ModelCatalog }
  | { status: "error"; message: string };

/**
 * One load per engine, shared by the model picker and the 思考 picker beside
 * it. The server caches each catalog for ten minutes, so remounting a picker
 * costs nothing worth debouncing.
 *
 * `onCatalog` hands the loaded list up so a sibling can read a model's metadata
 * (the composer's context ring wants `contextWindow`) off the list this hook
 * has already fetched instead of fetching it again. It is held in a ref rather
 * than depended on: it is an output, and refetching whenever the caller hands
 * down a new closure is exactly what this effect must not do.
 */
export function useModelCatalog(engine: EngineId, onCatalog?: (catalog: ModelCatalog) => void): CatalogState {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const notify = useRef(onCatalog);
  notify.current = onCatalog;

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
          notify.current?.(catalog);
        },
        (error: unknown) => {
          if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [engine]);

  return state;
}

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
  /** See `useModelCatalog`: the loaded list, handed up for a sibling to read. */
  onCatalog?: (catalog: ModelCatalog) => void;
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0]) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const state = useModelCatalog(engine, onCatalog);

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
