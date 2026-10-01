import type { EngineId, Settings } from "./types.js";

/** Codex's own web search: through the live web, through OpenAI's cached index, or not at all. */
export type WebSearchMode = "live" | "cached" | "disabled";

/**
 * 引擎选项: the capabilities a user can switch per engine — the ones that change
 * what the model can do, not how the user steers it. Each engine only has the
 * keys it can really honour (see {@link ENGINE_OPTION_DEFAULTS}); a key it
 * lacks is not shown for it at all.
 */
export interface EngineOptions {
  /** Delegating a subtask to a child agent with its own context. */
  subagents?: boolean;
  /** Notes the agent decides to keep across tasks. */
  memory?: boolean;
  /** The task's to-do list, the one the 计划 tab draws. */
  todos?: boolean;
  /** Web search and fetch, as one switch. */
  web?: boolean;
  /** Codex's web search, which has a middle setting. */
  webSearch?: WebSearchMode;
  /** Language-server diagnostics after each edit. */
  lsp?: boolean;
}

export type EngineOptionKey = keyof EngineOptions;

/**
 * What each engine supports, and what it does when the user switched nothing.
 * Mostly each engine's own default, with three exceptions:
 * - Claude Code's to-do list: off on newer models by its own default, but the
 *   计划 tab is drawn from it.
 * - OpenCode's LSP: off by its own default, cheap to run and useful to the model.
 * - Codex's memory: off by its own default. Vgent runs Codex in a home of its
 *   own, so the user's `~/.codex/config.toml` — which turns it on — never
 *   reaches it; on here is what that choice says they want.
 */
export const ENGINE_OPTION_DEFAULTS: Readonly<Record<EngineId, Readonly<EngineOptions>>> = {
  "claude-code": { subagents: true, memory: true, todos: true, web: true },
  codex: { subagents: true, memory: true, webSearch: "cached" },
  opencode: { subagents: true, memory: true, todos: true, web: true, lsp: true },
  vgent: { subagents: true, memory: true, todos: true },
};

const WEB_SEARCH_MODES: readonly WebSearchMode[] = ["live", "cached", "disabled"];

/** One option's value as stored, or `undefined` when it is not a valid value for that key. */
export function readEngineOption(key: EngineOptionKey, value: unknown): boolean | WebSearchMode | undefined {
  if (key === "webSearch") return WEB_SEARCH_MODES.find((mode) => mode === value);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The stored overrides, keeping only keys the engine supports and values of
 * the right type. A hand-edited file must not be able to make a turn throw.
 */
export function readEngineOptions(stored: unknown): Partial<Record<EngineId, EngineOptions>> {
  if (typeof stored !== "object" || stored === null) return {};
  const result: Partial<Record<EngineId, EngineOptions>> = {};
  for (const [engine, options] of Object.entries(stored)) {
    const supported = ENGINE_OPTION_DEFAULTS[engine as EngineId];
    if (supported == null || typeof options !== "object" || options === null) continue;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      if (!(key in supported)) continue;
      const read = readEngineOption(key as EngineOptionKey, value);
      if (read !== undefined) kept[key] = read;
    }
    if (Object.keys(kept).length > 0) result[engine as EngineId] = kept as EngineOptions;
  }
  return result;
}

/** What a turn of this engine runs with: its defaults, with the user's overrides on top. */
export function engineOptionsOf(settings: Pick<Settings, "engineOptions">, engine: EngineId): EngineOptions {
  return { ...ENGINE_OPTION_DEFAULTS[engine], ...readEngineOptions(settings.engineOptions)[engine] };
}
