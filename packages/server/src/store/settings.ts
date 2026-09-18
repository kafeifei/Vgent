import { parseMcpServers, type McpServerConfig } from "@vgent/engine";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EngineId, Logger, PermissionMode, Settings, UiDensity, UiTheme } from "../types.js";
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
  defaultEngine: "claude-code",
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
  mcpServers?: McpServerConfig[] | undefined;
  worktreeMaxCount?: number | undefined;
  /** 界面偏好. `undefined` puts the built-in default back. */
  theme?: UiTheme | undefined;
  density?: UiDensity | undefined;
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
  subscribe(listener: () => void): () => void;
}

const isSettings = (value: unknown): value is Settings =>
  typeof value === "object" && value !== null && typeof (value as Settings).defaultEngine === "string";

/**
 * A stored settings file brought up to the current shape. 运行模式 used to be a
 * per-thread default (`defaultPermissionMode`), so an older file's value becomes
 * the global one; the old field is then dropped rather than kept in sync.
 */
export function migrateSettings(stored: Settings & { defaultPermissionMode?: PermissionMode }): Settings {
  const { defaultPermissionMode, ...rest } = stored;
  return {
    ...rest,
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

  return {
    async get() {
      await ensureReady();
      return { ...(settings ?? DEFAULT_SETTINGS) };
    },
    async update(patch) {
      await ensureReady();
      const next: Settings = { ...(settings ?? DEFAULT_SETTINGS) };
      if (patch.defaultEngine != null) next.defaultEngine = patch.defaultEngine;
      if (patch.runMode != null) next.runMode = patch.runMode;
      if (patch.allowlist != null) next.allowlist = [...new Set(patch.allowlist)];
      if ("mcpServers" in patch) {
        if (patch.mcpServers == null || patch.mcpServers.length === 0) delete next.mcpServers;
        else next.mcpServers = patch.mcpServers;
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
      if ("worktreeMaxCount" in patch) {
        if (patch.worktreeMaxCount == null) delete next.worktreeMaxCount;
        else next.worktreeMaxCount = patch.worktreeMaxCount;
      }
      if ("theme" in patch) {
        if (patch.theme == null) delete next.theme;
        else next.theme = patch.theme;
      }
      if ("density" in patch) {
        if (patch.density == null) delete next.density;
        else next.density = patch.density;
      }
      settings = next;
      const work = () => writeJsonAtomic(path, next);
      chain = chain.then(work, work);
      await chain;
      for (const listener of [...listeners]) listener();
      return { ...next };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
