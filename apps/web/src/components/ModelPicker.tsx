import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient, getToken } from "@/lib/api";
import type { EngineDescriptor, EngineId, ModelCatalog } from "@/lib/types";
import { CascadeLevel, type CascadeNode } from "./CascadeMenu";
import { buildModelChoices, currentChoice, formatContext, preferredRoute, type EngineRoute, type ModelChoice } from "./modelChoices";
import { Popover } from "./Popover";
import { reasoningLabel } from "./reasoningLabels";
import { SourceIcon } from "./SourceIcon";

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

/** What a `ModelPicker` trigger shows: the effective model, and why. */
export type ModelChip = { label: string; title?: string };

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

/** What the task runs with besides the model itself — the third level of the menu. */
export interface ModelOptions {
  reasoningEffort: string | undefined;
  serviceTier: string | undefined;
  contextWindow: number | undefined;
}

/**
 * The second level under one model: 引擎 / 上下文 / 推理强度 / Fast, each opening
 * its values. They are read off `route` — the engine this row would run on —
 * because the same model offers different levels and windows under different
 * engines. A section the model has nothing to choose in is simply not there.
 *
 * `mine` is whether the task is on this very model and engine: only then do the
 * task's own choices tick a value; for any other row the ticks are that model's
 * defaults, since picking the row is what would apply.
 */
export function optionNodes({
  choice,
  route,
  mine,
  options,
  engineLocked,
  pick,
}: {
  choice: ModelChoice;
  route: EngineRoute;
  mine: boolean;
  /** Absent: only the engine is offered. */
  options: ModelOptions | undefined;
  engineLocked: boolean;
  pick: (route: EngineRoute, patch?: Partial<{ reasoningEffort: string; serviceTier: string | null; contextWindow: number | null }>) => void;
}): CascadeNode[] {
  const { entry } = route;
  const engineNode: CascadeNode[] = [
    {
      key: "engine",
      label: "引擎",
      hint: route.label,
      children: choice.routes.map((candidate) => ({
        key: candidate.engine,
        label: candidate.label,
        selected: candidate.engine === route.engine,
        disabled: engineLocked && candidate.engine !== route.engine,
        ...(engineLocked && candidate.engine !== route.engine ? { title: "已有对话的任务不能换引擎" } : {}),
        onPick: () => pick(candidate),
      })),
    },
  ];
  // The settings page picks a default *model*; what a task runs it with is the task's.
  if (options == null) return engineNode;
  const nodes = engineNode;

  const windows = entry.contextOptions ?? [];
  if (windows.length > 0) {
    const chosen = mine && options.contextWindow != null && windows.includes(options.contextWindow) ? options.contextWindow : (entry.contextWindow ?? windows[0]);
    nodes.push({
      key: "context",
      label: "上下文",
      ...(chosen != null ? { hint: formatContext(chosen) } : {}),
      children: windows.map((window) => ({
        key: String(window),
        label: formatContext(window),
        selected: window === chosen,
        // The engine's own window is the absence of a choice.
        onPick: () => pick(route, { contextWindow: window === (entry.contextWindow ?? windows[0]) ? null : window }),
      })),
    });
  }

  const levels = entry.reasoningLevels ?? [];
  if (levels.length > 0) {
    const level = mine && options.reasoningEffort != null && levels.includes(options.reasoningEffort) ? options.reasoningEffort : entry.defaultReasoningLevel;
    nodes.push({
      key: "effort",
      label: "推理强度",
      ...(level != null ? { hint: reasoningLabel(level) } : {}),
      children: levels.map((option) => ({
        key: option,
        label: reasoningLabel(option),
        selected: option === level,
        onPick: () => pick(route, { reasoningEffort: option }),
      })),
    });
  }

  // Fast is the one tier on offer today; a model that declares several would want a list here instead.
  const fast = entry.serviceTiers?.[0];
  if (fast != null) {
    const on = mine && options.serviceTier === fast.id;
    nodes.push({
      key: "fast",
      label: fast.name,
      hint: on ? "开" : "关",
      ...(fast.description != null ? { title: fast.description } : {}),
      children: [
        { key: "on", label: "开", selected: on, onPick: () => pick(route, { serviceTier: fast.id }) },
        { key: "off", label: "关", selected: !on, onPick: () => pick(route, { serviceTier: null }) },
      ],
    });
  }
  return nodes;
}

/**
 * 「选模型」: one menu, a row per model with its source's icon — a model that
 * several engines can run is one row, not one per engine. Clicking a row picks
 * it as it stands; its submenu is where the engine, the context window, the
 * 推理强度 and Fast are chosen, each a third level (用户画的层级，2026-09-20).
 */
export function ModelPicker({
  engines,
  engine,
  model,
  options,
  engineLocked = false,
  onPick,
  onPickOptions,
  onCatalog,
  trigger,
  align = "start",
  side = "bottom",
}: {
  /** The 引擎能力表 from the server. Empty while it is still loading. */
  engines: readonly EngineDescriptor[];
  engine: EngineId;
  model: string | undefined;
  /** What the task runs the model with. Absent — the settings page — leaves the menu at model and engine. */
  options?: ModelOptions;
  /** A task with history cannot cross engines: models only another engine runs are not offered. */
  engineLocked?: boolean;
  /** The engine always travels with the model. */
  onPick: (engine: EngineId, model: string | undefined) => void;
  /** `null` hands a choice back to the model's own default. Called after `onPick` when the row was not the current one. */
  onPickOptions?: (patch: Partial<{ reasoningEffort: string; serviceTier: string | null; contextWindow: number | null }>) => void;
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
  // What runs is shown, what the task persists is unchanged. When nobody knows
  // the default, the engine's own name keeps the chip from reading as「哪个引擎的默认？」.
  const chip: ModelChip =
    model != null
      ? { label: nameOf(model) }
      : effective != null
        ? { label: nameOf(effective), title: DEFAULT_MODEL_TITLE }
        : { label: `${label} 默认`, title: label };

  const lists = Object.fromEntries(
    Object.entries(states).flatMap(([id, state]) => (state.status === "ready" ? [[id, state.catalog.models]] : [])),
  ) as Partial<Record<EngineId, ModelCatalog["models"]>>;
  const choices = buildModelChoices(engines, lists, { engine, model });
  const mine = currentChoice(choices, engine, effective);
  const loading = Object.values(states).some((state) => state.status === "loading");
  const failures = Object.values(states).flatMap((state) => (state.status === "error" ? [state.message] : []));

  return (
    <Popover align={align} side={side} trigger={(props) => trigger(props, chip)}>
      {(close) => {
        const pick: Parameters<typeof optionNodes>[0]["pick"] = (route, patch) => {
          if (route.engine !== engine || route.entry.id !== model) onPick(route.engine, route.entry.id);
          if (patch != null) onPickOptions?.(patch);
          close();
        };
        const nodes: CascadeNode[] = choices.flatMap((choice, at) => {
          const route = preferredRoute(choice, engine, engineLocked);
          if (route == null) return [];
          const isMine = mine?.key === choice.key;
          const previous = choices[at - 1];
          return [
            {
              key: choice.key,
              label: choice.label,
              icon: <SourceIcon source={choice.source} />,
              selected: isMine,
              separated: previous != null && (previous.source.kind !== choice.source.kind || previous.source.id !== choice.source.id),
              onPick: () => pick(route),
              children: optionNodes({ choice, route, mine: isMine, options, engineLocked, pick }),
            },
          ];
        });
        return (
          <>
            {/* Every model of every source in one list; it has to be able to scroll. */}
            <CascadeLevel nodes={nodes} className="max-h-[calc(var(--spacing-xl)*14)] overflow-y-auto" />
            {loading && nodes.length === 0 && <div className="px-xs py-2xs text-fg-faint text-sm">加载中…</div>}
            {failures.map((message) => (
              <div key={message} className="px-xs py-2xs text-2xs text-fg-faint">
                模型列表加载失败：{message}
              </div>
            ))}
          </>
        );
      }}
    </Popover>
  );
}
