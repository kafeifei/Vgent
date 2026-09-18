import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient, getToken } from "@/lib/api";
import type { EngineDescriptor, EngineId, ModelCatalog } from "@/lib/types";
import { PopItem, PopTitle, Popover } from "./Popover";

export const modelLabel = (model: string | undefined): string => model ?? "默认";

/**
 * The model the engine will actually run with: the task's own choice, or the
 * default the server names on the catalog. Undefined while the catalog is still
 * loading, or when only the harness knows its own default — the chip then falls
 * back to「默认」.
 */
export const effectiveModel = (model: string | undefined, catalog: ModelCatalog | null | undefined): string | undefined =>
  model ?? catalog?.defaultModel;

/** The chip's tooltip when the name shown is the default rather than the task's pick. */
const DEFAULT_MODEL_TITLE = "默认模型（在设置里改）";

/** Why the other engines' groups are greyed out once a task has history. */
const LOCKED_HINT = "已有对话的任务不能跨引擎换模型";

/** What a `ModelPicker` trigger shows: the effective model, and why. */
export type ModelChip = { label: string; title?: string };

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

/**
 * Every engine's catalog at once, loaded in parallel. One engine failing is its
 * own group's warning line and never keeps the others from rendering.
 *
 * `onCatalog` still reports the *selected* engine's list — that is what the
 * composer's context ring and the 思考 picker measure against.
 */
function useAllCatalogs(
  engines: readonly EngineDescriptor[],
  selected: EngineId,
  onCatalog?: (catalog: ModelCatalog) => void,
): Record<string, CatalogState> {
  const [states, setStates] = useState<Record<string, CatalogState>>({});
  const notify = useRef(onCatalog);
  notify.current = onCatalog;
  const ids = engines.map((engine) => engine.id).join(",");

  useEffect(() => {
    const token = getToken();
    if (token == null || ids === "") return;
    let cancelled = false;
    const client = createClient(token);
    setStates(Object.fromEntries(ids.split(",").map((id) => [id, { status: "loading" } as CatalogState])));
    for (const id of ids.split(",") as EngineId[]) {
      client.listModels(id).then(
        (catalog) => {
          if (cancelled) return;
          setStates((current) => ({ ...current, [id]: { status: "ready", catalog } }));
          if (id === selected) notify.current?.(catalog);
        },
        (error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : String(error);
          setStates((current) => ({ ...current, [id]: { status: "error", message } }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [ids, selected]);

  return states;
}

/** The line under a group: where its list came from, or why there is none. */
function footerOf(state: CatalogState | undefined): string | undefined {
  if (state == null || state.status === "loading") return undefined;
  if (state.status === "error") return `模型列表加载失败：${state.message}`;
  return state.catalog.warning ?? describeSource(state.catalog.source);
}

/**
 * 「选模型即选引擎」: one popover, one group per engine, engine label as the
 * heading. The user never picks an engine — it comes along with the model.
 */
export function ModelPicker({
  engines,
  engine,
  model,
  engineLocked = false,
  onPick,
  onCatalog,
  trigger,
  align = "start",
  side = "bottom",
}: {
  /** The 引擎能力表 from the server. Empty while it is still loading. */
  engines: readonly EngineDescriptor[];
  engine: EngineId;
  model: string | undefined;
  /** A task with history cannot cross engines; the other groups say so and are dead. */
  engineLocked?: boolean;
  /** `model: undefined` means「默认」. The engine always travels with it. */
  onPick: (engine: EngineId, model: string | undefined) => void;
  /** See `useModelCatalog`: the *selected* engine's list, handed up for a sibling to read. */
  onCatalog?: (catalog: ModelCatalog) => void;
  /** `chip` is the effective model — a task that named none still shows what will run. */
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0], chip: ModelChip) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const states = useAllCatalogs(engines, engine, onCatalog);
  const selected = states[engine];
  const catalog = selected?.status === "ready" ? selected.catalog : undefined;
  const label = engines.find((entry) => entry.id === engine)?.label ?? engine;

  const effective = effectiveModel(model, catalog);
  /** What the catalog calls a model; its raw id until the list is loaded. */
  const nameOf = (id: string): string => catalog?.models.find((entry) => entry.id === id)?.label ?? id;
  // The 「默认」 row below stays the selected one: what runs is shown, what the
  // task persists is unchanged. When nobody knows the default, the engine's own
  // name keeps the chip from reading as「哪个引擎的默认？」.
  const chip: ModelChip =
    model != null
      ? { label: nameOf(model) }
      : effective != null
        ? { label: nameOf(effective), title: DEFAULT_MODEL_TITLE }
        : { label: `${label} 默认`, title: label };
  // A thread can carry a model the catalog no longer lists (another machine, an
  // older list). Losing the ability to see it would be worse than an odd row.
  const orphan =
    model != null && catalog != null && !catalog.models.some((entry) => entry.id === model) ? model : undefined;

  return (
    <Popover
      align={align}
      side={side}
      // Three engines' lists in one panel; it has to be able to scroll.
      className="max-h-[calc(var(--spacing-xl)*14)] overflow-y-auto"
      trigger={(props) => trigger(props, chip)}
    >
      {(close) => (
        <>
          {engines.map((entry) => {
            const state = states[entry.id];
            const locked = engineLocked && entry.id !== engine;
            const entries = state?.status === "ready" ? state.catalog.models : [];
            const defaultId = state?.status === "ready" ? state.catalog.defaultModel : undefined;
            const groupDefault =
              defaultId == null ? undefined : (entries.find((row) => row.id === defaultId)?.label ?? defaultId);
            const footer = footerOf(state);
            const pick = (next: string | undefined) => {
              onPick(entry.id, next);
              close();
            };

            return (
              <div key={entry.id}>
                <PopTitle>
                  <span className="flex items-center gap-2xs">
                    <span>{entry.label}</span>
                    {!entry.capabilities.approvals && <span className="text-fg-faint">只能全自动</span>}
                  </span>
                </PopTitle>
                {locked ? (
                  <div className="px-xs py-2xs text-2xs text-fg-faint">{LOCKED_HINT}</div>
                ) : (
                  <>
                    <PopItem selected={entry.id === engine && model === undefined} onClick={() => pick(undefined)}>
                      <span className="font-mono">默认{groupDefault != null && ` · ${groupDefault}`}</span>
                    </PopItem>
                    {entry.id === engine && orphan != null && (
                      <PopItem selected onClick={close}>
                        <span className="font-mono">当前：{orphan}</span>
                      </PopItem>
                    )}
                    {state?.status === "loading" && <PopItem disabled>加载中…</PopItem>}
                    {entries.map((row) => (
                      <PopItem key={row.id} selected={entry.id === engine && row.id === model} onClick={() => pick(row.id)}>
                        <span className="font-mono">{row.label}</span>
                      </PopItem>
                    ))}
                    {footer != null && <div className="px-xs py-2xs text-2xs text-fg-faint">{footer}</div>}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}
    </Popover>
  );
}
