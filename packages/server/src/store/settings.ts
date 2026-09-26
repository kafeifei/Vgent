import { parseMcpServers, type McpServerConfig } from "@vgent/engine";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EngineId, Logger, ModelPick, PermissionMode, Settings, UiDensity, UiTheme } from "../types.js";
import { silentLogger } from "../types.js";
import { readJsonOrQuarantine, writeJsonAtomic } from "./atomic-file.js";

/**
 * 运行模式 stays on 询问 by default. 自动改文件 would be the better default —
 * worktree, checkpoints and the 改动 tab review files afterwards — but it is
 * only contained on the in-house engine, whose write tools cannot leave the
 * working directory. The Claude Code harness bridge answers every edit-kind
 * tool with "allow" in that mode whatever the path, so a worktree task could
 * edit the user's main checkout unasked, and the harness gives us no hook to
 * stop it. Until that is closed the default does not opt anyone in.
 */
export const DEFAULT_SETTINGS: Settings = {
  defaultEngine: "vgent",
  runMode: "allow-reads",
  allowlist: [],
};

/** `defaultModel: undefined` clears it, which `Partial<Settings>` cannot express under `exactOptionalPropertyTypes`. */
export interface SettingsPatch {
  defaultEngine?: EngineId;
  runMode?: PermissionMode;
  /** The whole global allowlist. `[]` empties it. */
  allowlist?: string[];
  defaultModel?: string | undefined;
  /** 系统通知. `undefined` drops the field, which is the same as on. */
  systemNotifications?: boolean | undefined;
  /** 自动升级引擎运行时. `undefined` drops the field, which is the same as on. */
  autoUpgradeRuntimes?: boolean | undefined;
  mcpServers?: McpServerConfig[] | undefined;
  computerUseProvider?: "cua" | undefined;
  worktreeMaxCount?: number | undefined;
  /** Absent leaves it unchanged; `undefined` restores the project default. */
  defaultWorkspace?: Settings["defaultWorkspace"] | undefined;
  /** 界面偏好. `undefined` puts the built-in default back. */
  theme?: UiTheme | undefined;
  density?: UiDensity | undefined;
  /** The whole off list. An agent with nothing switched off is dropped from it; an empty map drops the field. */
  hiddenModels?: Partial<Record<EngineId, string[]>> | undefined;
  /** The whole map; an empty one drops the field. */
  modelPicks?: Record<string, ModelPick> | undefined;
  /** The whole order; an empty one drops the field. */
  providerOrder?: string[] | undefined;
}

/** A change to one model's `ModelPick`: a field set to `undefined` goes back to the model's own default. */
export type ModelPickPatch = { [K in keyof ModelPick]?: ModelPick[K] | undefined };

/** `current` with `patch` laid over it; `undefined` once nothing is left to remember. */
export function mergeModelPick(current: ModelPick | undefined, patch: ModelPickPatch): ModelPick | undefined {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value == null) delete next[field];
    else next[field] = value;
  }
  return Object.keys(next).length > 0 ? (next as ModelPick) : undefined;
}

/**
 * `modelPicks` as stored, plus the engine-only `modelEngines` map it replaced.
 * The picker reads it on every render, so a hand-edited file keeps what is
 * well-formed and drops the rest rather than throwing.
 */
function readModelPicks(stored: unknown, legacyEngines: unknown): Record<string, ModelPick> {
  const picks: Record<string, ModelPick> = {};
  if (typeof legacyEngines === "object" && legacyEngines !== null) {
    for (const [key, engine] of Object.entries(legacyEngines)) {
      if (typeof engine === "string") picks[key] = { engine: engine as EngineId };
    }
  }
  if (typeof stored === "object" && stored !== null) {
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value !== "object" || value === null) continue;
      const { engine, reasoningEffort, serviceTier, contextWindow } = value as Record<string, unknown>;
      const pick = mergeModelPick(picks[key], {
        ...(typeof engine === "string" ? { engine: engine as EngineId } : {}),
        ...(typeof reasoningEffort === "string" ? { reasoningEffort } : {}),
        ...(typeof serviceTier === "string" ? { serviceTier } : {}),
        ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      });
      if (pick != null) picks[key] = pick;
    }
  }
  return picks;
}

/**
 * Validates an incoming `mcpServers` value. `undefined` (the field was not
 * sent) and `null` (clear it) both mean "no list"; anything else has to be a
 * well-formed server array, because a silently dropped server is
 * indistinguishable from one whose tools the model never found.
 */
export function asMcpServers(value: unknown): McpServerConfig[] | undefined {
  if (value == null) return undefined;
  return parseMcpServers(value);
}

export interface SettingsStore {
  get(): Promise<Settings>;
  update(patch: SettingsPatch): Promise<Settings>;
  /**
   * A patch computed from the settings as they are at the moment it is applied.
   * For read-modify-write fields (one switch of `hiddenModels`): with `get()`
   * then `update()`, two quick clicks would each start from the same list and
   * the second would undo the first.
   */
  mutate(patchOf: (current: Settings) => SettingsPatch): Promise<Settings>;
  subscribe(listener: () => void): () => void;
}

const isSettings = (value: unknown): value is Settings =>
  typeof value === "object" && value !== null && typeof (value as Settings).defaultEngine === "string";

/**
 * A stored settings file brought up to the current shape. 运行模式 used to be a
 * per-thread default (`defaultPermissionMode`), so an older file's value becomes
 * the global one; the old field is then dropped rather than kept in sync. The
 * engine-per-model map (`modelEngines`) became part of `modelPicks` the same way.
 */
export function migrateSettings(stored: Settings & { defaultPermissionMode?: PermissionMode; modelEngines?: unknown }): Settings {
  const { defaultPermissionMode, hiddenModels, providerOrder, modelEngines, modelPicks, computerUseProvider, defaultWorkspace, ...rest } = stored;
  // Read on every model listing, so a hand-edited file must not be able to make it throw.
  const hidden = Object.entries(typeof hiddenModels === "object" && hiddenModels !== null ? hiddenModels : {}).flatMap(([engine, ids]) =>
    Array.isArray(ids) ? [[engine, ids.filter((id) => typeof id === "string")] as const] : [],
  );
  const picks = readModelPicks(modelPicks, modelEngines);
  return {
    ...rest,
    ...(computerUseProvider === "cua" ? { computerUseProvider } : {}),
    ...(defaultWorkspace === "project" || defaultWorkspace === "worktree" ? { defaultWorkspace } : {}),
    ...(hidden.length > 0 ? { hiddenModels: Object.fromEntries(hidden) } : {}),
    ...(Array.isArray(providerOrder) ? { providerOrder: providerOrder.filter((id) => typeof id === "string") } : {}),
    ...(Object.keys(picks).length > 0 ? { modelPicks: picks } : {}),
    runMode: stored.runMode ?? defaultPermissionMode ?? DEFAULT_SETTINGS.runMode,
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist.filter((name) => typeof name === "string") : [],
  };
}

export function createSettingsStore(dataDir: string, log: Logger = silentLogger): SettingsStore {
  const path = join(dataDir, "settings.json");
  const listeners = new Set<() => void>();
  let settings: Settings | undefined;
  let ready: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const ensureReady = (): Promise<void> => {
    ready ??= (async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const stored = await readJsonOrQuarantine<Settings>(path, { validate: isSettings, log });
      settings = stored == null ? { ...DEFAULT_SETTINGS } : migrateSettings(stored);
    })();
    return ready;
  };

  // Nothing between reading `settings` and replacing it awaits, so every patch
  // builds on the one before it.
  const apply = async (patchOf: (current: Settings) => SettingsPatch): Promise<Settings> => {
    await ensureReady();
    const patch = patchOf({ ...(settings ?? DEFAULT_SETTINGS) });
    const next: Settings = { ...(settings ?? DEFAULT_SETTINGS) };
    if (patch.defaultEngine != null) next.defaultEngine = patch.defaultEngine;
    if (patch.runMode != null) next.runMode = patch.runMode;
    if (patch.allowlist != null) next.allowlist = [...new Set(patch.allowlist)];
    if ("mcpServers" in patch) {
      if (patch.mcpServers == null || patch.mcpServers.length === 0) delete next.mcpServers;
      else next.mcpServers = patch.mcpServers;
    }
    if ("computerUseProvider" in patch) {
      if (patch.computerUseProvider == null) delete next.computerUseProvider;
      else next.computerUseProvider = patch.computerUseProvider;
    }
    if ("defaultModel" in patch) {
      if (patch.defaultModel == null) delete next.defaultModel;
      else next.defaultModel = patch.defaultModel;
    }
    // Absent means on, so an older file needs no migration; `false` is stored.
    if ("systemNotifications" in patch) {
      if (patch.systemNotifications == null) delete next.systemNotifications;
      else next.systemNotifications = patch.systemNotifications;
    }
    if ("autoUpgradeRuntimes" in patch) {
      if (patch.autoUpgradeRuntimes == null) delete next.autoUpgradeRuntimes;
      else next.autoUpgradeRuntimes = patch.autoUpgradeRuntimes;
    }
    if ("worktreeMaxCount" in patch) {
      if (patch.worktreeMaxCount == null) delete next.worktreeMaxCount;
      else next.worktreeMaxCount = patch.worktreeMaxCount;
    }
    if ("defaultWorkspace" in patch) {
      if (patch.defaultWorkspace == null) delete next.defaultWorkspace;
      else next.defaultWorkspace = patch.defaultWorkspace;
    }
    if ("theme" in patch) {
      if (patch.theme == null) delete next.theme;
      else next.theme = patch.theme;
    }
    if ("density" in patch) {
      if (patch.density == null) delete next.density;
      else next.density = patch.density;
    }
    if ("hiddenModels" in patch) {
      const kept = Object.entries(patch.hiddenModels ?? {}).flatMap(([engine, ids]) => {
        const unique = [...new Set(ids)];
        return unique.length > 0 ? [[engine, unique] as const] : [];
      });
      if (kept.length === 0) delete next.hiddenModels;
      else next.hiddenModels = Object.fromEntries(kept);
    }
    if ("modelPicks" in patch) {
      if (patch.modelPicks == null || Object.keys(patch.modelPicks).length === 0) delete next.modelPicks;
      else next.modelPicks = patch.modelPicks;
    }
    if ("providerOrder" in patch) {
      const order = [...new Set(patch.providerOrder ?? [])];
      if (order.length === 0) delete next.providerOrder;
      else next.providerOrder = order;
    }
    settings = next;
    const work = () => writeJsonAtomic(path, next);
    chain = chain.then(work, work);
    await chain;
    for (const listener of [...listeners]) listener();
    return { ...next };
  };

  return {
    async get() {
      await ensureReady();
      return { ...(settings ?? DEFAULT_SETTINGS) };
    },
    update: (patch) => apply(() => patch),
    mutate: apply,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
