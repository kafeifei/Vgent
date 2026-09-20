import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CLAUDE_CODE_DATA_DIR, DEFAULT_CODEX_DATA_DIR } from "@vgent/engines";
import { ConflictError, VgentServerError } from "./errors.js";
import type { Logger } from "./types.js";
import { silentLogger } from "./types.js";

/**
 * 引擎运行时 — the CLI and SDK a harness engine actually runs, and keeping them
 * current.
 *
 * Three layers sit under a harness engine: the AI SDK adapter
 * (`@ai-sdk/harness-claude-code` / `-codex`, shipped inside this app), the
 * vendor's SDK it drives (`@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk`)
 * and the vendor's CLI. The adapter installs the last two into
 * `<harness dir>/.harness-bootstrap/<id>/` from a lockfile it carries, and it
 * pins them hard: adapter releases keep shipping the same pair for weeks while
 * the vendors release almost daily. Upgrading the adapter therefore does not
 * bring a newer CLI; the pair has to be moved forward in that directory.
 *
 * That is what this module does, in place and with pnpm — the directory is a
 * pnpm project and stays one:
 *
 *   1. never while a task of that engine is live (a bridge process would end up
 *      loading half of each version);
 *   2. `package.json` and the lockfile are copied aside first;
 *   3. `pnpm add --save-exact` moves the pair, then the CLI has to answer
 *      `--version` with the expected number — otherwise the copies go back and
 *      `pnpm install --frozen-lockfile` restores the old tree;
 *   4. the new version stays 未验证 until a turn of that engine ends well. A
 *      turn that dies before producing anything rolls it back and remembers the
 *      version as bad, so an automatic upgrade does not walk into it again.
 *
 * The adapter's own marker (`.bootstrap-<hash>.ok`) is left alone, so it does
 * not reinstall its pins on top. A new adapter release with a different recipe
 * does, and the next check simply upgrades again.
 */

const execFileAsync = promisify(execFile);

export type HarnessEngineId = "claude-code" | "codex";

/** `package name → exact version`. */
export type VersionSet = Record<string, string>;

interface RuntimeSpec {
  engine: HarnessEngineId;
  label: string;
  /** The engine's sandbox directory; the bootstrap lives under it. */
  dataDir: string;
  bootstrapDir: string;
  /** The package whose version is shown as *the* version: the CLI. */
  primary: string;
  /** Every package that moves together, the primary included. */
  packages: readonly string[];
  /** Prints the CLI's version; its output must contain the primary's new version. */
  versionCommand: readonly string[];
  /** The newest consistent set, straight from the registry. */
  resolveLatest: (fetchJson: FetchJson) => Promise<VersionSet>;
}

type FetchJson = (url: string) => Promise<unknown>;

const REGISTRY = "https://registry.npmjs.org";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const versionOf = (value: unknown, what: string): string => {
  if (isRecord(value) && typeof value.version === "string" && value.version !== "") return value.version;
  throw new Error(`npm registry 没有返回 ${what} 的版本`);
};

const SPECS: readonly RuntimeSpec[] = [
  {
    engine: "claude-code",
    label: "Claude Code",
    dataDir: DEFAULT_CLAUDE_CODE_DATA_DIR,
    bootstrapDir: join(".harness-bootstrap", "claude-code"),
    primary: "@anthropic-ai/claude-code",
    packages: ["@anthropic-ai/claude-code", "@anthropic-ai/claude-agent-sdk"],
    versionCommand: ["./node_modules/.bin/claude", "--version"],
    // The Agent SDK names the CLI it was built against (`claudeCodeVersion`);
    // the two are released in lockstep and only that pair is ever installed.
    resolveLatest: async (fetchJson) => {
      const sdk = await fetchJson(`${REGISTRY}/@anthropic-ai/claude-agent-sdk/latest`);
      const cli = isRecord(sdk) && typeof sdk.claudeCodeVersion === "string" ? sdk.claudeCodeVersion : undefined;
      if (cli == null || cli === "") throw new Error("最新的 Claude Agent SDK 没有声明配套的 Claude Code 版本");
      return { "@anthropic-ai/claude-code": cli, "@anthropic-ai/claude-agent-sdk": versionOf(sdk, "Claude Agent SDK") };
    },
  },
  {
    engine: "codex",
    label: "Codex",
    dataDir: DEFAULT_CODEX_DATA_DIR,
    bootstrapDir: join(".harness-bootstrap", "codex"),
    // The SDK depends on the CLI at exactly its own version, so one number covers both.
    primary: "@openai/codex-sdk",
    packages: ["@openai/codex-sdk"],
    // The CLI is the SDK's own dependency, so pnpm links no `.bin/codex` at the
    // top. In pnpm's layout a package's dependencies sit next to its real
    // directory, which is where the SDK itself finds the CLI.
    versionCommand: [
      process.execPath,
      "-e",
      [
        'const { realpathSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const cli = join(realpathSync("node_modules/@openai/codex-sdk"), "..", "codex", "bin", "codex.js");',
        'process.stdout.write(require("node:child_process").execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }));',
      ].join(" "),
    ],
    resolveLatest: async (fetchJson) => ({
      "@openai/codex-sdk": versionOf(await fetchJson(`${REGISTRY}/@openai/codex-sdk/latest`), "Codex SDK"),
    }),
  },
];

/** What the settings page shows for one engine. */
export interface HarnessRuntimeStatus {
  engine: HarnessEngineId;
  label: string;
  /** The CLI package the versions below are about. */
  package: string;
  /** Absent until the engine has been used once: the adapter installs on first run. */
  installed?: string;
  latest?: string;
  updateAvailable: boolean;
  /** Upgraded, and no turn has ended well on it yet. */
  unverified: boolean;
  /** The version a rollback would go back to. */
  previous?: string;
  /** Versions that were rolled back, which the automatic upgrade skips. */
  bad: string[];
  /** A task of this engine is live, so nothing can be installed right now. */
  busy: boolean;
  /** An install or rollback is running. */
  working: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

interface RuntimeState {
  previous?: VersionSet;
  unverified?: boolean;
  bad?: string[];
  latest?: VersionSet;
  lastCheckedAt?: string;
  lastError?: string;
}

export interface HarnessRuntimeOptions {
  log?: Logger;
  /** Whether a task of this engine is running or parked. Installing under one is refused. */
  isBusy: (engine: HarnessEngineId) => Promise<boolean>;
  /** Test seams. */
  fetchJson?: FetchJson;
  run?: (command: string, args: readonly string[], cwd: string) => Promise<string>;
  /** Overrides each engine's sandbox directory (tests, and nothing else). */
  dataDirs?: Partial<Record<HarnessEngineId, string>>;
  now?: () => Date;
}

export interface HarnessRuntime {
  status(): Promise<HarnessRuntimeStatus[]>;
  /** Asks the registry again, then reports. */
  check(): Promise<HarnessRuntimeStatus[]>;
  /** To the newest set. Resolves with the fresh status; rejects when refused or when the install was rolled back. */
  upgrade(engine: HarnessEngineId): Promise<HarnessRuntimeStatus>;
  rollback(engine: HarnessEngineId): Promise<HarnessRuntimeStatus>;
  /** The run loop's word on how a turn of this engine went. */
  reportTurn(engine: string, outcome: { ok: boolean; produced: boolean }): Promise<void>;
  /** Check, and upgrade whatever is idle, newer and not known bad. Never throws. */
  autoUpgrade(): Promise<void>;
}

/** `1.2.10` vs `1.2.9`, numerically; anything unparsable compares as equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => value.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) return 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

const defaultFetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`npm registry ${response.status}`);
  return response.json();
};

const defaultRun = async (command: string, args: readonly string[], cwd: string): Promise<string> => {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    cwd,
    // A CLI download on a slow line takes a while; ten minutes is a hang, not a line.
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "1" },
  });
  return `${stdout}${stderr}`;
};

export function createHarnessRuntime(options: HarnessRuntimeOptions): HarnessRuntime {
  const log = options.log ?? silentLogger;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const run = options.run ?? defaultRun;
  const now = options.now ?? (() => new Date());
  const working = new Set<HarnessEngineId>();

  const specOf = (engine: string): RuntimeSpec | undefined => SPECS.find((entry) => entry.engine === engine);
  const dataDirOf = (spec: RuntimeSpec): string => options.dataDirs?.[spec.engine] ?? spec.dataDir;
  const dirOf = (spec: RuntimeSpec): string => join(dataDirOf(spec), spec.bootstrapDir);
  const statePath = (spec: RuntimeSpec): string => join(dataDirOf(spec), ".vgent-runtime.json");
  const backupDir = (spec: RuntimeSpec): string => join(dirOf(spec), ".vgent-previous");

  const readJson = async (path: string): Promise<unknown> => {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text == null) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  };

  const readState = async (spec: RuntimeSpec): Promise<RuntimeState> => {
    const value = await readJson(statePath(spec));
    return isRecord(value) ? (value as RuntimeState) : {};
  };

  const writeState = async (spec: RuntimeSpec, state: RuntimeState): Promise<void> => {
    await mkdir(dataDirOf(spec), { recursive: true });
    await writeFile(statePath(spec), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  };

  /** What is really in `node_modules`, not what `package.json` asks for. */
  const installedSet = async (spec: RuntimeSpec): Promise<VersionSet | undefined> => {
    const set: VersionSet = {};
    for (const name of spec.packages) {
      const manifest = await readJson(join(dirOf(spec), "node_modules", name, "package.json"));
      if (!isRecord(manifest) || typeof manifest.version !== "string") return undefined;
      set[name] = manifest.version;
    }
    return set;
  };

  const describe = async (spec: RuntimeSpec): Promise<HarnessRuntimeStatus> => {
    const [state, installed, busy] = await Promise.all([readState(spec), installedSet(spec), options.isBusy(spec.engine)]);
    const current = installed?.[spec.primary];
    const latest = state.latest?.[spec.primary];
    return {
      engine: spec.engine,
      label: spec.label,
      package: spec.primary,
      ...(current != null ? { installed: current } : {}),
      ...(latest != null ? { latest } : {}),
      updateAvailable: current != null && latest != null && compareVersions(current, latest) < 0,
      unverified: state.unverified === true,
      ...(state.previous?.[spec.primary] != null ? { previous: state.previous[spec.primary] as string } : {}),
      bad: state.bad ?? [],
      busy,
      working: working.has(spec.engine),
      ...(state.lastCheckedAt != null ? { lastCheckedAt: state.lastCheckedAt } : {}),
      ...(state.lastError != null ? { lastError: state.lastError } : {}),
    };
  };

  const checkOne = async (spec: RuntimeSpec): Promise<void> => {
    const state = await readState(spec);
    try {
      const latest = await spec.resolveLatest(fetchJson);
      const { lastError: _cleared, ...rest } = state;
      await writeState(spec, { ...rest, latest, lastCheckedAt: now().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`查询 ${spec.label} 最新版本失败`, error);
      await writeState(spec, { ...state, lastCheckedAt: now().toISOString(), lastError: `检查更新失败：${message}` });
    }
  };

  /** pnpm, against the directory's own store — the one the adapter's install uses. */
  const pnpm = (spec: RuntimeSpec, args: readonly string[]): Promise<string> =>
    run("pnpm", [...args, "--store-dir", ".pnpm-store"], dirOf(spec));

  const verify = async (spec: RuntimeSpec, expected: string): Promise<void> => {
    const [command, ...args] = spec.versionCommand;
    const output = await run(command as string, args, dirOf(spec));
    if (!output.includes(expected)) {
      throw new Error(`${spec.label} 装完后报告的版本不是 ${expected}：${output.trim().slice(0, 200)}`);
    }
  };

  /**
   * The three files that decide what gets installed. The workspace file is one
   * of them because it names, *by version*, the packages allowed to run their
   * install script (`allowBuilds: '@anthropic-ai/claude-code@2.1.245': true`) —
   * and that script is what puts the native CLI in place.
   */
  const PROJECT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"] as const;

  const copyProjectFiles = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const name of PROJECT_FILES) {
      // Codex's recipe has no workspace file; a missing one is not an error.
      await copyFile(join(from, name), join(to, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };

  const restoreBackup = async (spec: RuntimeSpec): Promise<void> => {
    await copyProjectFiles(backupDir(spec), dirOf(spec));
    await pnpm(spec, ["install", "--frozen-lockfile"]);
  };

  /** Moves every `name@oldVersion` in the workspace file to the version being installed. */
  const retargetWorkspace = async (spec: RuntimeSpec, from: VersionSet, to: VersionSet): Promise<void> => {
    const path = join(dirOf(spec), "pnpm-workspace.yaml");
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text == null) return;
    let next = text;
    for (const [name, version] of Object.entries(to)) {
      const old = from[name];
      if (old != null) next = next.split(`${name}@${old}`).join(`${name}@${version}`);
    }
    if (next !== text) await writeFile(path, next);
  };

  const guard = async <T>(spec: RuntimeSpec, action: string, body: () => Promise<T>): Promise<T> => {
    if (working.has(spec.engine)) throw new ConflictError(`${spec.label} 正在安装，稍等`, "runtime_working");
    if (await options.isBusy(spec.engine)) {
      throw new ConflictError(`有 ${spec.label} 的任务在运行，等它结束再${action}`, "runtime_busy");
    }
    working.add(spec.engine);
    try {
      return await body();
    } finally {
      working.delete(spec.engine);
    }
  };

  const upgradeOne = (spec: RuntimeSpec): Promise<void> =>
    guard(spec, "升级", async () => {
      const installed = await installedSet(spec);
      if (installed == null) {
        throw new VgentServerError({ message: `${spec.label} 还没安装：第一次用这个引擎时会自动装好，之后才能升级`, status: 409, code: "runtime_not_installed" });
      }
      await checkOne(spec);
      const state = await readState(spec);
      const target = state.latest;
      const wanted = target?.[spec.primary];
      if (target == null || wanted == null) throw new VgentServerError({ message: state.lastError ?? "查不到最新版本", status: 502, code: "runtime_no_latest" });
      if (compareVersions(installed[spec.primary] as string, wanted) >= 0) return;

      await copyProjectFiles(dirOf(spec), backupDir(spec));
      log.info(`升级 ${spec.label}：${installed[spec.primary]} → ${wanted}`);
      try {
        await retargetWorkspace(spec, installed, target);
        await pnpm(spec, ["add", "--save-exact", ...Object.entries(target).map(([name, version]) => `${name}@${version}`)]);
        await verify(spec, wanted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`升级 ${spec.label} 到 ${wanted} 失败，退回 ${installed[spec.primary]}`, error);
        await restoreBackup(spec).catch((restoreError) => log.error(`退回 ${spec.label} 失败`, restoreError));
        await writeState(spec, {
          ...state,
          bad: [...new Set([...(state.bad ?? []), wanted])],
          lastError: `升级到 ${wanted} 失败，已退回 ${installed[spec.primary]}：${message.slice(0, 300)}`,
        });
        throw new VgentServerError({ message: `升级到 ${wanted} 失败，已退回 ${installed[spec.primary]}`, status: 500, code: "runtime_upgrade_failed" });
      }
      const { lastError: _cleared, ...rest } = state;
      await writeState(spec, { ...rest, previous: installed, unverified: true });
    });

  const rollbackOne = (spec: RuntimeSpec, reason?: string): Promise<void> =>
    guard(spec, "回退", async () => {
      const state = await readState(spec);
      const installed = await installedSet(spec);
      if (state.previous == null) throw new VgentServerError({ message: "没有可以回退的上一版", status: 409, code: "runtime_no_previous" });
      log.info(`回退 ${spec.label}：${installed?.[spec.primary] ?? "?"} → ${state.previous[spec.primary]}`);
      await restoreBackup(spec);
      const abandoned = installed?.[spec.primary];
      const { previous: _gone, unverified: _flag, lastError: _cleared, ...rest } = state;
      await writeState(spec, {
        ...rest,
        // Rolled back on purpose or by a failed turn: either way the automatic
        // upgrade must not put the same version straight back.
        bad: [...new Set([...(state.bad ?? []), ...(abandoned != null ? [abandoned] : [])])],
        ...(reason != null ? { lastError: reason } : {}),
      });
    });

  const must = (engine: string): RuntimeSpec => {
    const spec = specOf(engine);
    if (spec == null) throw new VgentServerError({ message: `${engine} 没有可升级的运行时`, status: 404, code: "runtime_unknown_engine" });
    return spec;
  };

  return {
    status: () => Promise.all(SPECS.map(describe)),

    async check() {
      await Promise.all(SPECS.map(checkOne));
      return Promise.all(SPECS.map(describe));
    },

    async upgrade(engine) {
      const spec = must(engine);
      await upgradeOne(spec);
      return describe(spec);
    },

    async rollback(engine) {
      const spec = must(engine);
      await rollbackOne(spec);
      return describe(spec);
    },

    async reportTurn(engine, outcome) {
      const spec = specOf(engine);
      if (spec == null) return;
      const state = await readState(spec);
      if (state.unverified !== true) return;
      if (outcome.ok) {
        const { unverified: _flag, ...rest } = state;
        await writeState(spec, rest);
        // The old version is no longer needed for a rollback that will not come.
        await pnpm(spec, ["store", "prune"]).catch((error) => log.warn(`清理 ${spec.label} 的旧版本缓存失败`, error));
        return;
      }
      // A turn that got as far as producing output failed for its own reasons
      // (a tool, the network, the model). One that died with nothing to show,
      // right after an upgrade, is the upgrade's doing until proven otherwise.
      if (outcome.produced) return;
      const installed = (await installedSet(spec))?.[spec.primary];
      await rollbackOne(spec, `${installed ?? "新版本"} 装上后第一轮就没跑起来，已自动退回 ${state.previous?.[spec.primary] ?? "上一版"}`).catch(
        (error) => log.error(`自动回退 ${spec.label} 失败`, error),
      );
    },

    async autoUpgrade() {
      for (const spec of SPECS) {
        try {
          await checkOne(spec);
          const status = await describe(spec);
          if (!status.updateAvailable || status.busy || status.working || status.unverified) continue;
          if (status.latest != null && status.bad.includes(status.latest)) continue;
          await upgradeOne(spec);
        } catch (error) {
          // Refused because a task started in between, or rolled back: both are
          // already recorded where the settings page reads them.
          log.warn(`自动升级 ${spec.label} 没有完成`, error);
        }
      }
    },
  };
}
