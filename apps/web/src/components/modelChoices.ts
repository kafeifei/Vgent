import type { EngineDescriptor, EngineId, ModelEntry } from "@/lib/types";

/** How one engine names a model, and what it says about it. */
export interface EngineRoute {
  engine: EngineId;
  label: string;
  entry: ModelEntry;
}

/**
 * One row of the model menu: a model, shown once however many engines can run
 * it. Which engine does is a choice *under* the model — the second level of the
 * menu — instead of the heading the user used to have to pick a group by.
 */
export interface ModelChoice {
  key: string;
  label: string;
  source: NonNullable<ModelEntry["source"]>;
  /** In the order the Engine submenu lists them: the in-house engine first, then the server's order. */
  routes: EngineRoute[];
}

const UNKNOWN_SOURCE: ModelChoice["source"] = { kind: "provider", name: "" };

/**
 * Folds the per-engine catalogs into the menu's rows. Entries that carry the
 * same `modelKey` are the same model; rows keep the order their *source* first
 * appeared in (the Codex login's models, then each provider's, then Claude's…),
 * and all of a source's models stay together even when only some engines list
 * them.
 */
export function buildModelChoices(
  engines: readonly EngineDescriptor[],
  catalogs: Partial<Record<EngineId, readonly ModelEntry[]>>,
  /** A hidden model is still offered to the task that is already on it. */
  current?: { engine: EngineId; model: string | undefined },
): ModelChoice[] {
  const byKey = new Map<string, ModelChoice>();
  const sourceOrder: string[] = [];
  for (const engine of engines) {
    for (const entry of catalogs[engine.id] ?? []) {
      if (entry.hidden === true && !(current?.engine === engine.id && current.model === entry.id)) continue;
      const key = entry.modelKey ?? `${engine.id}/${entry.id}`;
      const source = entry.source ?? UNKNOWN_SOURCE;
      const sourceKey = `${source.kind}/${source.id ?? source.name}`;
      if (!sourceOrder.includes(sourceKey)) sourceOrder.push(sourceKey);
      const choice: ModelChoice = byKey.get(key) ?? { key, label: entry.label, source, routes: [] };
      choice.routes.push({ engine: engine.id, label: engine.label, entry });
      byKey.set(key, choice);
    }
  }
  const sourceOf = (choice: ModelChoice) => sourceOrder.indexOf(`${choice.source.kind}/${choice.source.id ?? choice.source.name}`);
  const choices = [...byKey.values()];
  for (const choice of choices) choice.routes.sort((a, b) => Number(b.engine === "vgent") - Number(a.engine === "vgent"));
  // Stable: within a source, rows stay in the order the catalogs listed them.
  return choices.map((choice, at) => ({ choice, at })).sort((a, b) => sourceOf(a.choice) - sourceOf(b.choice) || a.at - b.at).map(({ choice }) => choice);
}

/** The row the task is on, if the menu has it. */
export const currentChoice = (choices: readonly ModelChoice[], engine: EngineId, model: string | undefined): ModelChoice | undefined =>
  model == null ? undefined : choices.find((choice) => choice.routes.some((route) => route.engine === engine && route.entry.id === model));

/**
 * The engine a row would run on when it is simply clicked: the one the task is
 * already on when that engine can run this model, else the first listed. A task
 * with history cannot change engines, so there it is that engine or nothing.
 */
export function preferredRoute(choice: ModelChoice, engine: EngineId, engineLocked: boolean): EngineRoute | undefined {
  const same = choice.routes.find((route) => route.engine === engine);
  return same ?? (engineLocked ? undefined : choice.routes[0]);
}

/** `272000` → `272K`, `1050000` → `1M`. */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.floor(tokens / 100_000) / 10;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000)}K`;
}
