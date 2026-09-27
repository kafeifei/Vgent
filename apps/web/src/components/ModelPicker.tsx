import { onModelsChanged } from "@/lib/modelEvents";
import { onAccountsChanged } from "@/lib/accountEvents";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createClient, getToken, type ApiClient, type ModelPickPatch } from "@/lib/api";
import type { EngineDescriptor, EngineId, ModelCatalog, ModelEntry, ModelPick } from "@/lib/types";
import { CascadeLevel, type CascadeNode } from "./CascadeMenu";
import {
  buildModelChoices,
  currentChoice,
  formatContext,
  optionsOn,
  preferredRoute,
  type EngineRoute,
  type ModelChoice,
  type OptionsSet,
} from "./modelChoices";
import { Popover } from "./Popover";
import { reasoningLabel } from "./reasoningLabels";
import { SourceIcon } from "./SourceIcon";

export const ModelCatalogClientContext = createContext<Pick<ApiClient, "listModels"> | null>(null);

export const modelLabel = (model: string | undefined): string => model ?? "默认";

/**
 * The model that actually runs: the task's own choice, else the default the
 * server names, else the first model the catalog lists. A harness that keeps
 * its own default (Claude Code) names nothing, and「Claude Code 默认」is not a
 * model — the first listed one is selected instead. Undefined only while the
 * catalog is still loading or empty.
 */
export function resolveModel(model: string | undefined, catalog: ModelCatalog | null | undefined): string | undefined {
  if (model != null) return model;
  if (catalog == null) return undefined;
  const visible = catalog.models.filter((entry) => entry.hidden !== true);
  if (catalog.defaultModel != null && (visible.length === 0 || visible.some((entry) => entry.id === catalog.defaultModel))) {
    return catalog.defaultModel;
  }
  return visible[0]?.id;
}

export const effectiveModel = resolveModel;

/** The composer's chip: the model, then how hard it thinks, then Fast when that is on. */
export function modelChipLabel(name: string, effort: string | undefined, fast: string | undefined): string {
  return [name, effort, fast].filter((part) => part != null && part !== "").join(" ");
}

/** A level that means thinking is off, so it does not belong in the chip. */
const EFFORT_OFF = new Set(["none", "disabled"]);

/** What a `ModelPicker` trigger shows: the effective model, and why. */
export type ModelChip = { label: string; title?: string };

export type CatalogState =
  | { status: "loading" }
  | { status: "ready"; catalog: ModelCatalog }
  | { status: "error"; message: string };

/**
 * Every engine's catalog at once, loaded in parallel. One engine failing is its
 * own warning line and never keeps the others from rendering. The server caches
 * each catalog for ten minutes, so remounting a picker costs nothing worth
 * debouncing.
 *
 * `onCatalog` hands the *selected* engine's list up so a sibling can read a
 * model's metadata off what this hook already fetched instead of fetching it
 * again — the composer's context ring wants `contextWindow`. It is held in a ref
 * rather than depended on: it is an output, and refetching whenever the caller
 * hands down a new closure is exactly what this effect must not do.
 */
function useAllCatalogs(
  engines: readonly EngineDescriptor[],
  selected: EngineId,
  onCatalog?: (catalog: ModelCatalog) => void,
): Record<string, CatalogState> {
  const injectedClient = useContext(ModelCatalogClientContext);
  const [accountRevision, setAccountRevision] = useState(0);
  useEffect(() => {
    if (!injectedClient) return;
    const refresh = () => setAccountRevision(n => n + 1);
    const stopAccounts = onAccountsChanged(injectedClient, refresh);
    const stopModels = onModelsChanged(injectedClient, refresh);
    return () => { stopAccounts(); stopModels(); };
  }, [injectedClient]);
  const [states, setStates] = useState<Record<string, CatalogState>>({});
  const notify = useRef(onCatalog);
  notify.current = onCatalog;
  const ids = engines.map((engine) => engine.id).join(",");

  useEffect(() => {
    const token = getToken();
    const client = injectedClient ?? (token == null ? null : createClient(token));
    if (client == null || ids === "") return;
    let cancelled = false;
    setStates(current => Object.fromEntries(ids.split(",").map((id) => [id, current[id] ?? { status: "loading" } as CatalogState])));
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
  }, [ids, selected, injectedClient, accountRevision]);

  return states;
}

/** What the task runs with besides the model itself — the rows above 模型. */
export interface ModelOptions {
  reasoningEffort: string | undefined;
  serviceTier: string | undefined;
  contextWindow: number | undefined;
}

/** A change to those, `null` handing a choice back to the model's own default. */
export type OptionsPatch = Partial<OptionsSet>;

/** The level a model runs at: the task's own pick where the model offers it, else the model's default. */
const levelOf = (entry: ModelEntry, chosen: string | undefined): string | undefined =>
  chosen != null && entry.reasoningLevels?.includes(chosen) === true ? chosen : entry.defaultReasoningLevel;

/**
 * What a row in the model list runs with, dimmed right after its name the way
 * Cursor writes「Opus 5.5 1M High Fast」: a context window other than the model's
 * own, the 推理强度, Fast when it is on. The task's own row reads its choices;
 * any other, what that model was last picked with — its defaults if never.
 */
function variantOf(entry: ModelEntry, options: ModelOptions | ModelPick | undefined): string {
  const windows = entry.contextOptions ?? [];
  const own = entry.contextWindow ?? windows[0];
  const context = options?.contextWindow != null && options.contextWindow !== own && windows.includes(options.contextWindow) ? formatContext(options.contextWindow) : undefined;
  const level = levelOf(entry, options?.reasoningEffort);
  const effort = level == null ? undefined : EFFORT_OFF.has(level) ? "不思考" : reasoningLabel(level);
  const fast = entry.serviceTiers?.[0];
  return [context, effort, fast != null && options?.serviceTier === fast.id ? fast.name : undefined].filter((part) => part != null).join(" ");
}

/**
 * The rows above 模型: Fast / 上下文 / 推理强度 / 引擎 — what the model the task is
 * already on runs with. They are read off `route`, the engine it runs on, since
 * the same model offers different levels and windows under different engines. A
 * knob the model does not have is simply not a row.
 */
export function optionNodes({
  choice,
  route,
  options,
  engineLocked,
  onOptions,
  onEngine,
}: {
  choice: ModelChoice;
  route: EngineRoute;
  /** Absent — the settings page — leaves the menu at 引擎 and 模型. */
  options: ModelOptions | undefined;
  engineLocked: boolean;
  onOptions: (patch: OptionsPatch) => void;
  onEngine: (route: EngineRoute) => void;
}): CascadeNode[] {
  const { entry } = route;
  const nodes: CascadeNode[] = [];

  // The settings page picks a default *model*; what a task runs it with is the task's.
  if (options != null) {
    // Fast is the one tier on offer today; a model that declared several would want a submenu instead.
    const fast = entry.serviceTiers?.[0];
    if (fast != null) {
      const on = options.serviceTier === fast.id;
      nodes.push({
        key: "fast",
        label: fast.name,
        toggle: on,
        ...(fast.description != null ? { title: fast.description } : {}),
        // A switch is flipped where it stands: the menu stays open.
        onPick: () => onOptions({ serviceTier: on ? null : fast.id }),
      });
    }

    const windows = entry.contextOptions ?? [];
    if (windows.length > 0) {
      const own = entry.contextWindow ?? windows[0];
      const chosen = options.contextWindow != null && windows.includes(options.contextWindow) ? options.contextWindow : own;
      nodes.push({
        key: "context",
        label: "上下文",
        ...(chosen != null ? { hint: formatContext(chosen) } : {}),
        children: windows.map((window) => ({
          key: String(window),
          label: formatContext(window),
          selected: window === chosen,
          // The menu stays open: only switching models closes it.
          onPick: () => onOptions({ contextWindow: window === own ? null : window }),
        })),
      });
    }

    const levels = entry.reasoningLevels ?? [];
    if (levels.length > 0) {
      const level = levelOf(entry, options.reasoningEffort);
      nodes.push({
        key: "effort",
        label: "推理强度",
        ...(level != null ? { hint: reasoningLabel(level) } : {}),
        children: levels.map((option) => ({
          key: option,
          label: reasoningLabel(option),
          selected: option === level,
          onPick: () => onOptions({ reasoningEffort: option }),
        })),
      });
    }
  }

  nodes.push({
    key: "engine",
    label: "引擎",
    hint: route.label,
    children: choice.routes.map((candidate) => ({
      key: candidate.engine,
      label: candidate.label,
      selected: candidate.engine === route.engine,
      disabled: engineLocked && candidate.engine !== route.engine,
      ...(engineLocked && candidate.engine !== route.engine ? { title: "已有对话的任务不能换引擎" } : {}),
      onPick: () => onEngine(candidate),
    })),
  });
  return nodes;
}

/**
 * 模型 的子菜单: a row per model — a model several engines can run is one row,
 * not one per engine — captioned by its source and searchable, because a gateway
 * brings hundreds. Clicking a row runs that model on whichever engine it would
 * get; 引擎 back on the first level is where that is overridden.
 */
function ModelList({
  choices,
  mine,
  engine,
  engineLocked,
  picks,
  options,
  loading,
  failures,
  onPick,
}: {
  choices: readonly ModelChoice[];
  mine: ModelChoice | undefined;
  engine: EngineId;
  engineLocked: boolean;
  picks: Readonly<Record<string, ModelPick>> | undefined;
  options: ModelOptions | undefined;
  loading: boolean;
  failures: readonly string[];
  onPick: (choice: ModelChoice, route: EngineRoute) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const nodes: CascadeNode[] = choices.flatMap((choice) => {
    const isMine = mine?.key === choice.key;
    // The task's own row shows the engine it is really on; any other, the one it would get.
    const route =
      (isMine ? choice.routes.find((candidate) => candidate.engine === engine) : undefined) ??
      preferredRoute(choice, engine, engineLocked, picks);
    if (route == null) return [];
    if (needle !== "" && !`${choice.label} ${route.entry.id}`.toLowerCase().includes(needle)) return [];
    // Another model's row reads what it was last picked with: what clicking it would run.
    const variant = variantOf(route.entry, isMine ? options : picks?.[choice.key]);
    return [
      {
        key: choice.key,
        label:
          variant === "" ? (
            choice.label
          ) : (
            <>
              {choice.label} <span className="text-fg-faint">{variant}</span>
            </>
          ),
        icon: <SourceIcon source={choice.source} />,
        ...(choice.source.name !== "" ? { section: choice.source.name } : {}),
        selected: isMine,
        onPick: () => onPick(choice, route),
      },
    ];
  });

  return (
    <div className="w-[calc(var(--spacing-3xl)*5)]">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜索模型"
        aria-label="搜索模型"
        className="block w-full border-border border-b bg-transparent px-xs py-2xs text-fg text-sm outline-none placeholder:text-fg-faint"
      />
      {/* Every model of every source in one list; it has to be able to scroll. */}
      <CascadeLevel nodes={nodes} revealSelected className="max-h-[calc(var(--spacing-xl)*14)] overflow-y-auto pt-2xs" />
      {nodes.length === 0 && (
        <div className="px-xs py-2xs text-fg-faint text-sm">{loading ? "加载中…" : needle === "" ? "没有可用的模型" : "没有匹配的模型"}</div>
      )}
      {failures.map((message) => (
        <div key={message} className="px-xs py-2xs text-2xs text-fg-faint">
          模型列表加载失败：{message}
        </div>
      ))}
    </div>
  );
}

/**
 * 「选模型」: the knobs first — Fast / 上下文 / 推理强度 / 引擎, each reading as its
 * current value — and 模型 last, its own submenu being the list of them
 * (用户画的层级，2026-09-22，照 Cursor). What the task is on is therefore one
 * click away from any of its settings, and the long list is behind the one row
 * that needs it.
 */
export function ModelPicker({
  engines,
  engine,
  model,
  options,
  engineLocked = false,
  onPick,
  onPickOptions,
  picks,
  onRemember,
  adoptRemembered = false,
  onCatalog,
  /** When nothing is chosen yet, write the resolved model back so the chip is a real selection. */
  commitDefault = false,
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
  /**
   * The engine always travels with the model, and so does what it runs with:
   * `options` is what the menu switches the task onto — the new model's
   * remembered ones, or the task's own when only the engine changed. Absent
   * where nothing was switched (settling on the default) or there are no
   * options (the settings page).
   */
  onPick: (engine: EngineId, model: string | undefined, options?: OptionsSet) => void;
  /** `null` hands a choice back to the model's own default. */
  onPickOptions?: (patch: OptionsPatch) => void;
  /**
   * 记住上次选择, per `modelKey` (`Settings.modelPicks`): the engine and the
   * options each model was last picked with, and how a new choice is kept.
   */
  picks?: Readonly<Record<string, ModelPick>>;
  onRemember?: (modelKey: string, pick: ModelPickPatch) => void;
  /**
   * A new task: the model it would run on — the default one, before anything is
   * picked — comes with what it was last run with, handed up through
   * `onPickOptions` whenever that model changes.
   */
  adoptRemembered?: boolean;
  /** See `useAllCatalogs`: the *selected* engine's list, handed up for a sibling to read. */
  onCatalog?: (catalog: ModelCatalog) => void;
  commitDefault?: boolean;
  /** `chip` is the model plus, in the composer, its 推理强度 and Fast. */
  trigger: (props: Parameters<Parameters<typeof Popover>[0]["trigger"]>[0], chip: ModelChip) => ReactNode;
  align?: "start" | "end";
  side?: "bottom" | "top";
}) {
  const states = useAllCatalogs(engines, engine, onCatalog);
  const selected = states[engine];
  const catalog = selected?.status === "ready" ? selected.catalog : undefined;
  const label = engines.find((entry) => entry.id === engine)?.label ?? engine;

  const resolved = resolveModel(model, catalog);
  /** What the catalog calls a model; its raw id until the list is loaded. */
  const nameOf = (id: string): string => catalog?.models.find((entry) => entry.id === id)?.label ?? id;
  const modelName = resolved != null ? nameOf(resolved) : undefined;
  const entry = resolved != null ? catalog?.models.find((item) => item.id === resolved) : undefined;
  const level = options != null && entry != null ? levelOf(entry, options.reasoningEffort) : undefined;
  const fast = entry?.serviceTiers?.[0];
  const fastName = fast != null && options?.serviceTier === fast.id ? fast.name : undefined;
  // The composer chip carries 推理强度 and Fast; the settings page names the model alone.
  const chip: ModelChip = {
    label:
      modelName == null
        ? "…"
        : options == null
          ? modelName
          : modelChipLabel(modelName, level != null && !EFFORT_OFF.has(level) ? reasoningLabel(level) : undefined, fastName),
  };

  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const committed = useRef<string | null>(null);
  useEffect(() => {
    if (!commitDefault || model != null || resolved == null) return;
    const key = `${engine}/${resolved}`;
    if (committed.current === key) return;
    committed.current = key;
    pickRef.current(engine, resolved);
  }, [commitDefault, engine, model, resolved]);

  const lists = Object.fromEntries(
    Object.entries(states).flatMap(([id, state]) => (state.status === "ready" ? [[id, state.catalog.models]] : [])),
  ) as Partial<Record<EngineId, ModelCatalog["models"]>>;
  const choices = buildModelChoices(engines, lists, { engine, model: model ?? resolved });
  const mine = currentChoice(choices, engine, resolved);
  const loading = Object.values(states).some((state) => state.status === "loading");
  const failures = Object.values(states).flatMap((state) => (state.status === "error" ? [state.message] : []));

  // The row whose knobs the first level shows: the resolved model, on the engine it runs on.
  const route = mine == null ? undefined : (mine.routes.find((candidate) => candidate.engine === engine) ?? preferredRoute(mine, engine, engineLocked, picks));

  const pickOptionsRef = useRef(onPickOptions);
  pickOptionsRef.current = onPickOptions;
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const adopted = useRef<string | null>(null);
  const adoptKey = adoptRemembered ? mine?.key : undefined;
  const adoptEntry = route?.entry;
  // Once per model, not on every change of `picks`: those change because this
  // very menu wrote one, and adopting again would race the caller's own state.
  useEffect(() => {
    if (adoptKey == null || adoptEntry == null || adopted.current === adoptKey) return;
    adopted.current = adoptKey;
    pickOptionsRef.current?.(optionsOn(adoptEntry, picksRef.current?.[adoptKey]));
  }, [adoptKey, adoptEntry]);

  return (
    <Popover align={align} side={side} className="min-w-[calc(var(--spacing-3xl)*4)]" trigger={(props) => trigger(props, chip)}>
      {(close) => {
        const run = (next: EngineRoute, carried: ModelPick | ModelOptions | undefined): void => {
          if (next.engine === engine && next.entry.id === model) return;
          onPick(next.engine, next.entry.id, options != null ? optionsOn(next.entry, carried) : undefined);
        };
        const nodes: CascadeNode[] =
          mine != null && route != null
            ? optionNodes({
                choice: mine,
                route,
                options,
                engineLocked,
                onOptions: (patch) => {
                  // 记住上次选择: what a model is set to here is what it comes with next time.
                  onPickOptions?.(patch);
                  onRemember?.(mine.key, patch);
                },
                onEngine: (next) => {
                  // 记住上次选择: an engine picked by hand is this model's from now on.
                  // The menu stays open — only picking a different model closes it.
                  // Same model, so the task keeps its own options wherever the new engine offers them.
                  onRemember?.(mine.key, { engine: next.engine });
                  run(next, options);
                },
              })
            : // The catalog has not named a model yet. 引擎 can still be changed.
              [
                {
                  key: "engine",
                  label: "引擎",
                  hint: label,
                  children: engines.map((candidate) => ({
                    key: candidate.id,
                    label: candidate.label,
                    selected: candidate.id === engine,
                    disabled: engineLocked && candidate.id !== engine,
                    ...(engineLocked && candidate.id !== engine ? { title: "已有对话的任务不能换引擎" } : {}),
                    onPick: () => {
                      if (candidate.id !== engine) onPick(candidate.id, undefined);
                    },
                  })),
                },
              ];
        nodes.push({
          key: "model",
          label: "模型",
          hint: modelName ?? "…",
          separated: true,
          content: (
            <ModelList
              choices={choices}
              mine={mine}
              engine={engine}
              engineLocked={engineLocked}
              picks={picks}
              options={options}
              loading={loading}
              failures={failures}
              onPick={(choice, next) => {
                // Another model brings what it was last picked with; its own row keeps the task's.
                run(next, choice.key === mine?.key ? options : picks?.[choice.key]);
                close();
              }}
            />
          ),
        });
        return <CascadeLevel nodes={nodes} />;
      }}
    </Popover>
  );
}
