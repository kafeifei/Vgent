import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CLAUDE_CODE_DATA_DIR, DEFAULT_CODEX_DATA_DIR } from "@vgent/engines";
import { ConflictError, VgentServerError } from "./errors.js";
import { writeJsonAtomic } from "./store/atomic-file.js";
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
 *   2. download and verify in a temporary project while the installed CLI
 *      remains usable; only then copy the project files aside;
 *   3. swap the verified `node_modules` into place with filesystem renames;
 *      keep the old tree as a rollback point until a turn succeeds;
 *   4. until a turn ends well, further upgrades keep that same rollback point;
 *      a separate, temporary backup undoes a failed installation. A
 *      turn that dies before producing anything rolls it back and remembers the
 *      version as bad, so an automatic upgrade does not walk into it again.
 *
 * A commit can still be cut off half way — the app is quit during the short
 * swap — which leaves the top-level links gone. The intent is written down before the live tree is touched
 * (`upgrading`), and whoever next finds that note with its writer dead restores
 * the previous tree (`recover`, run at start-up and before every
 * other operation). Everything that happens is appended to
 * `<harness dir>/.vgent-runtime.log`, pnpm's own output included on a failure:
 * the desktop shell keeps no server log, and this is the one place that has to
 * be readable after the fact.
 *
 * The adapter's own marker (`.bootstrap-<hash>.ok`) is left alone, so it does
 * not reinstall its pins on top. A new recipe would make it: the hash covers
 * the bridge script, which Vgent patches, so every build that touches the
 * patch changes it. When such a recipe would only move the runtime backwards,
 * `recover` takes it on in place (`adoptRecipe`); one that pins something
 * newer, or other dependencies, is the adapter's to install, and the next
 * check simply upgrades again.
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

/** An adapter's bootstrap recipe, as `HarnessV1.getBootstrap()` gives it. */
export interface BootstrapRecipe {
  harnessId: string;
  bootstrapDir: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  commands: ReadonlyArray<{ command: string }>;
}

/**
 * The name the adapter's marker carries for a recipe,
 * `.bootstrap-<identity>.ok`: `@ai-sdk/harness` hashes it this way
 * (`hashHarnessBootstrap`, schema 1) and does not export the function. Should
 * the two ever differ, the marker is simply not found and the adapter installs
 * its own pins, as it would without Vgent.
 */
export function bootstrapIdentity(recipe: BootstrapRecipe): string {
  const hash = createHash("sha256");
  const push = (value: string): void => {
    hash.update(value, "utf8");
    hash.update("\0");
  };
  push(recipe.harnessId);
  push(recipe.bootstrapDir);
  for (const file of [...recipe.files].sort((a, b) => a.path.localeCompare(b.path))) {
    push(file.path);
    push(file.content);
  }
  push(JSON.stringify(recipe.commands));
  push("1");
  return hash.digest("hex").slice(0, 16);
}

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
  /** The directory is there but the packages are not: an install was cut off and has not been repaired yet. */
  broken: boolean;
  lastCheckedAt?: string;
  lastError?: string;
}

interface RuntimeState {
  /** Written before an install touches anything, removed when it is over either way. */
  upgrading?: { from: VersionSet; to: VersionSet; pid: number; startedAt: string; stage?: string; preservePrevious?: boolean };
  /** How often an install of a version was cut off. Twice, and only a click installs it. */
  interrupted?: Record<string, number>;
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
  /**
   * The adapter's current recipe for an engine. Absent, a new recipe is never
   * taken on in place and the adapter reinstalls its pins as it sees fit.
   */
  bootstrapRecipe?: (engine: HarnessEngineId) => Promise<BootstrapRecipe | undefined>;
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
  /**
   * Repairs an install that was cut off (the app quit mid-download), and takes
   * on a new adapter recipe that would only downgrade. Never throws; cheap when
   * there is nothing to do. A session must not start before the first call is over.
   */
  recover(): Promise<void>;
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
    await writeJsonAtomic(statePath(spec), state, { mode: 0o600 });
  };

  /**
   * Every change to the state file goes through here, one at a time per engine
   * and always from a fresh read. A check that was waiting on npm while an
   * install finished must not write its stale copy back — least of all a stale
   * `upgrading` note, which the next `recover` would act on.
   */
  const chains = new Map<HarnessEngineId, Promise<unknown>>();
  const updateState = (spec: RuntimeSpec, change: (state: RuntimeState) => RuntimeState): Promise<void> => {
    const next = (chains.get(spec.engine) ?? Promise.resolve()).then(
      async () => writeState(spec, change(await readState(spec))),
      async () => writeState(spec, change(await readState(spec))),
    );
    chains.set(spec.engine, next.catch(() => undefined));
    return next;
  };

  const CHECK_FAILED = "检查更新失败：";

  /** The after-the-fact record: one line per event, plus the tool's output when something failed. */
  const record = async (spec: RuntimeSpec, line: string, detail?: string): Promise<void> => {
    const text = `${now().toISOString()} ${line}\n${detail != null && detail !== "" ? `${detail.trim().slice(-4000)}\n` : ""}`;
    await mkdir(dataDirOf(spec), { recursive: true }).catch(() => undefined);
    await appendFile(join(dataDirOf(spec), ".vgent-runtime.log"), text, { mode: 0o600 }).catch(() => undefined);
  };

  const errorDetail = (error: unknown): string => {
    const parts = error as { message?: string; stdout?: string; stderr?: string };
    return [parts.message, parts.stdout, parts.stderr].filter((part) => typeof part === "string" && part !== "").join("\n");
  };

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
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
    const [state, installed, busy, project] = await Promise.all([
      readState(spec),
      installedSet(spec),
      options.isBusy(spec.engine),
      stat(join(dirOf(spec), "package.json")).catch(() => undefined),
    ]);
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
      ...(state.unverified === true && state.previous?.[spec.primary] != null ? { previous: state.previous[spec.primary] as string } : {}),
      bad: state.bad ?? [],
      busy,
      working: working.has(spec.engine),
      // A project with no packages in it is not「never installed」: that one has no project either.
      broken: installed == null && project != null && !working.has(spec.engine),
      ...(state.lastCheckedAt != null ? { lastCheckedAt: state.lastCheckedAt } : {}),
      ...(state.lastError != null ? { lastError: state.lastError } : {}),
    };
  };

  const checkOne = async (spec: RuntimeSpec): Promise<void> => {
    try {
      const latest = await spec.resolveLatest(fetchJson);
      await updateState(spec, (state) => {
        // Only a failed *check* is forgotten by a good one; why an install was
        // rolled back or repaired stays until something supersedes it.
        const { lastError, ...rest } = state;
        const kept = lastError != null && !lastError.startsWith(CHECK_FAILED) ? { lastError } : {};
        return { ...rest, ...kept, latest, lastCheckedAt: now().toISOString() };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`查询 ${spec.label} 最新版本失败`, error);
      await updateState(spec, (state) => ({ ...state, lastCheckedAt: now().toISOString(), lastError: `${CHECK_FAILED}${message}` }));
    }
  };

  /** pnpm, against the directory's own store — the one the adapter's install uses. */
  const pnpm = (spec: RuntimeSpec, args: readonly string[], cwd = dirOf(spec)): Promise<string> =>
    run("pnpm", [...args, "--store-dir", join(dirOf(spec), ".pnpm-store")], cwd);

  const verify = async (spec: RuntimeSpec, expected: string, cwd = dirOf(spec)): Promise<void> => {
    const [command, ...args] = spec.versionCommand;
    const output = await run(command as string, args, cwd);
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
        return rm(join(to, name), { force: true });
      });
    }
  };

  const restoreBackup = async (spec: RuntimeSpec, source = backupDir(spec)): Promise<void> => {
    const previousModules = join(source, "node_modules");
    if (await stat(previousModules).catch(() => undefined)) {
      const discard = await mkdtemp(join(dataDirOf(spec), ".vgent-discard-"));
      const currentModules = join(dirOf(spec), "node_modules");
      const displaced = join(discard, "node_modules");
      let movedCurrent = false;
      try {
        if (await stat(currentModules).catch(() => undefined)) {
          renameSync(currentModules, displaced);
          movedCurrent = true;
        }
        renameSync(previousModules, currentModules);
        await copyProjectFiles(source, dirOf(spec));
      } catch (error) {
        if (movedCurrent && !(await stat(currentModules).catch(() => undefined))) renameSync(displaced, currentModules);
        throw error;
      } finally {
        await rm(discard, { recursive: true, force: true }).catch((error) => log.warn(`清理 ${spec.label} 临时文件失败`, error));
      }
      return;
    }
    // Older installations only backed up project files. Repair those using
    // their store; new upgrades always keep the entire working tree above.
    await copyProjectFiles(source, dirOf(spec));
    await pnpm(spec, ["install", "--frozen-lockfile"]);
  };

  /** Moves every `name@oldVersion` in the workspace file to the version being installed. */
  const retargetWorkspace = async (dir: string, from: VersionSet, to: VersionSet): Promise<void> => {
    const path = join(dir, "pnpm-workspace.yaml");
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text == null) return;
    let next = text;
    for (const [name, version] of Object.entries(to)) {
      const old = from[name];
      if (old != null) next = next.split(`${name}@${old}`).join(`${name}@${version}`);
    }
    if (next !== text) await writeFile(path, next);
  };

  /** pnpm's generated bin shims and metadata embed the installation's absolute path. */
  const relocateCandidate = async (stage: string, destination: string): Promise<void> => {
    const pending = [join(stage, "node_modules")];
    const needle = Buffer.from(stage);
    while (pending.length > 0) {
      const dir = pending.pop() as string;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile() && (await stat(path)).size <= 2 * 1024 * 1024) {
          const bytes = await readFile(path);
          if (!bytes.includes(needle)) continue;
          const text = bytes.toString("utf8");
          if (!Buffer.from(text).equals(bytes)) throw new Error(`pnpm 产物包含无法安全改写的路径：${path}`);
          await writeFile(path, text.replaceAll(stage, destination));
        }
      }
    }
  };

  const guard = async <T>(spec: RuntimeSpec, action: string, body: () => Promise<T>, exclusive = false): Promise<T> => {
    if (working.has(spec.engine) || (exclusive && working.size > 0)) {
      throw new ConflictError("有引擎正在安装，等它完成再试", "runtime_working");
    }
    if (await options.isBusy(spec.engine)) {
      throw new ConflictError(`有 ${spec.label} 的任务在运行，等它结束再${action}`, "runtime_busy");
    }
    // isBusy reads the task store asynchronously; another request may have
    // entered the guard while that read was pending.
    if (working.has(spec.engine) || (exclusive && working.size > 0)) {
      throw new ConflictError("有引擎正在安装，等它完成再试", "runtime_working");
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

      // A slow or failing registry must never unlink the CLI a new task needs.
      // Staging beside the bootstrap also guarantees same-volume renames.
      const stage = await mkdtemp(join(dataDirOf(spec), ".vgent-candidate-"));
      const packages = Object.entries(target).map(([name, version]) => `${name}@${version}`);
      let retainStage = false;
      try {
        await copyProjectFiles(dirOf(spec), stage);
        await retargetWorkspace(stage, installed, target);
        try {
          await pnpm(spec, ["add", "--save-exact", ...packages], stage);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await record(spec, `upgrade ${spec.label} -> ${wanted}: download FAILED, keeping ${installed[spec.primary]}`, errorDetail(error));
          await updateState(spec, (current) => ({ ...current, lastError: `下载 ${wanted} 失败，现有 ${installed[spec.primary]} 未受影响：${message.slice(0, 300)}` }));
          throw new VgentServerError({ message: `下载 ${wanted} 失败，现有 ${installed[spec.primary]} 未受影响`, status: 500, code: "runtime_upgrade_failed" });
        }
        try {
          await verify(spec, wanted, stage);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await record(spec, `upgrade ${spec.label} -> ${wanted}: verification FAILED, keeping ${installed[spec.primary]}`, errorDetail(error));
          await updateState(spec, (current) => ({
            ...current,
            bad: [...new Set([...(current.bad ?? []), wanted])],
            lastError: `${wanted} 装好后无法启动，现有 ${installed[spec.primary]} 未受影响：${message.slice(0, 300)}`,
          }));
          throw new VgentServerError({ message: `${wanted} 装好后无法启动，现有 ${installed[spec.primary]} 未受影响`, status: 500, code: "runtime_upgrade_failed" });
        }

        if (await options.isBusy(spec.engine)) {
          throw new ConflictError(`${spec.label} 已有任务开始运行，等它结束再升级`, "runtime_busy");
        }

        // Generated .bin scripts carry the staging path in NODE_PATH. Rewrite
        // them while the old installation is still untouched, before the swap.
        try {
          await relocateCandidate(stage, dirOf(spec));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await record(spec, `upgrade ${spec.label} -> ${wanted}: relocation FAILED, keeping ${installed[spec.primary]}`, errorDetail(error));
          await updateState(spec, (current) => ({ ...current, lastError: `准备 ${wanted} 失败，现有 ${installed[spec.primary]} 未受影响：${message.slice(0, 300)}` }));
          throw new VgentServerError({ message: `准备 ${wanted} 失败，现有 ${installed[spec.primary]} 未受影响`, status: 500, code: "runtime_upgrade_failed" });
        }
        if (await options.isBusy(spec.engine)) {
          throw new ConflictError(`${spec.label} 已有任务开始运行，等它结束再升级`, "runtime_busy");
        }

        // A -> B -> C need not run a turn on B. Keep A for a runtime rollback,
        // and save B separately so a failed/interrupted C install restores B.
        const preservePrevious = state.unverified === true && state.previous != null;
        const undoDir = preservePrevious ? join(stage, ".vgent-replaced") : backupDir(spec);
        await rm(join(undoDir, "node_modules"), { recursive: true, force: true });
        await copyProjectFiles(dirOf(spec), undoDir);
        const intent = { from: installed, to: target, pid: process.pid, startedAt: now().toISOString(), stage, preservePrevious };
        // Only this short swap can change the live tree. A note lets
        // the next app start repair an interruption in that window.
        await updateState(spec, (current) => ({
          ...current,
          upgrading: intent,
        }));
        retainStage = true;
        log.info(`升级 ${spec.label}：${installed[spec.primary]} → ${wanted}`);
        await record(spec, `upgrade ${spec.label} ${installed[spec.primary]} -> ${wanted}: committing`);
        if (await options.isBusy(spec.engine)) {
          await updateState(spec, ({ upgrading: _over, ...current }) => current);
          retainStage = false;
          throw new ConflictError(`${spec.label} 已有任务开始运行，等它结束再升级`, "runtime_busy");
        }
        try {
          renameSync(join(dirOf(spec), "node_modules"), join(undoDir, "node_modules"));
          renameSync(join(stage, "node_modules"), join(dirOf(spec), "node_modules"));
          await copyProjectFiles(stage, dirOf(spec));
          await verify(spec, wanted);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`升级 ${spec.label} 到 ${wanted} 失败，退回 ${installed[spec.primary]}`, error);
          await record(spec, `upgrade ${spec.label} -> ${wanted}: commit FAILED, restoring ${installed[spec.primary]}`, errorDetail(error));
          let restored = false;
          await restoreBackup(spec, undoDir).then(() => { restored = true; }, async (restoreError) => {
            log.error(`退回 ${spec.label} 失败`, restoreError);
            await record(spec, `restore ${spec.label}: FAILED`, errorDetail(restoreError));
          });
          await updateState(spec, ({ upgrading: _over, ...current }) => ({
            ...current,
            ...(!restored ? { upgrading: intent } : {}),
            ...(restored ? { bad: [...new Set([...(current.bad ?? []), wanted])] } : {}),
            lastError: restored
              ? `升级到 ${wanted} 失败，已退回 ${installed[spec.primary]}：${message.slice(0, 300)}`
              : `升级到 ${wanted} 失败，恢复 ${installed[spec.primary]} 也失败：${message.slice(0, 300)}`,
          }));
          retainStage = !restored;
          throw new VgentServerError({ message: restored ? `升级到 ${wanted} 失败，已退回 ${installed[spec.primary]}` : `升级到 ${wanted} 失败，恢复旧版也失败`, status: 500, code: "runtime_upgrade_failed" });
        }
        await updateState(spec, ({ upgrading: _over, lastError: _cleared, ...current }) => ({
          ...current,
          previous: preservePrevious ? (state.previous ?? installed) : installed,
          unverified: true,
        }));
        retainStage = false;
        await record(spec, `upgrade ${spec.label} -> ${wanted}: installed, awaiting a good turn`);
      } finally {
        if (!retainStage) await rm(stage, { recursive: true, force: true }).catch((error) => log.warn(`清理 ${spec.label} 候选运行时失败`, error));
      }
    }, true);

  const rollbackOne = (spec: RuntimeSpec, reason?: string): Promise<void> =>
    guard(spec, "回退", async () => {
      const state = await readState(spec);
      const installed = await installedSet(spec);
      if (state.previous == null || state.unverified !== true) throw new VgentServerError({ message: "没有可以回退的上一版", status: 409, code: "runtime_no_previous" });
      log.info(`回退 ${spec.label}：${installed?.[spec.primary] ?? "?"} → ${state.previous[spec.primary]}`);
      await restoreBackup(spec);
      await record(spec, `rollback ${spec.label} ${installed?.[spec.primary] ?? "?"} -> ${state.previous[spec.primary]}${reason != null ? `: ${reason}` : ""}`);
      const abandoned = installed?.[spec.primary];
      await updateState(spec, ({ previous: _gone, unverified: _flag, lastError: _cleared, ...current }) => ({
        ...current,
        // Rolled back on purpose or by a failed turn: either way the automatic
        // upgrade must not put the same version straight back.
        bad: [...new Set([...(current.bad ?? []), ...(abandoned != null ? [abandoned] : [])])],
        ...(reason != null ? { lastError: reason } : {}),
      }));
    });

  /**
   * An `upgrading` note whose writer is gone means the swap was left half way.
   * New upgrades put the saved module tree back directly; older installations
   * only have project-file backups and still need pnpm. Being interrupted
   * says nothing about the target version, so it is not marked bad.
   */
  const recoverOne = async (spec: RuntimeSpec): Promise<void> => {
    const state = await readState(spec);
    const note = state.upgrading;
    if (note == null || working.has(spec.engine)) return;
    if (note.pid !== process.pid && isAlive(note.pid)) return;
    const stage = typeof note.stage === "string" && dirname(resolve(note.stage)) === resolve(dataDirOf(spec)) && basename(note.stage).startsWith(".vgent-candidate-")
      ? note.stage
      : undefined;
    const from = note.from[spec.primary] ?? "上一版";
    working.add(spec.engine);
    try {
      if (note.preservePrevious && stage == null) throw new Error("缺少本次安装的恢复目录");
      const undoDir = note.preservePrevious ? join(stage as string, ".vgent-replaced") : backupDir(spec);
      log.warn(`${spec.label} 上次升级被打断，恢复到 ${from}`);
      await record(spec, `recover ${spec.label}: upgrade to ${note.to[spec.primary]} was interrupted, restoring ${from}`);
      if (stage != null && (await installedSet(spec))?.[spec.primary] === from) {
        await copyProjectFiles(undoDir, dirOf(spec));
      } else {
        await restoreBackup(spec, undoDir);
      }
      const target = note.to[spec.primary] ?? "";
      await updateState(spec, ({ upgrading: _done, ...current }) => ({
        ...current,
        interrupted: { ...current.interrupted, [target]: (current.interrupted?.[target] ?? 0) + 1 },
        lastError: `上次升级到 ${note.to[spec.primary]} 时被打断（多半是安装途中退出了 app），已恢复到 ${from}`,
      }));
      if (stage != null) await rm(stage, { recursive: true, force: true }).catch((error) => log.warn(`清理 ${spec.label} 候选运行时失败`, error));
    } catch (error) {
      log.error(`恢复 ${spec.label} 失败`, error);
      await record(spec, `recover ${spec.label}: FAILED`, errorDetail(error));
      await updateState(spec, (current) => ({ ...current, lastError: `上次升级被打断，自动恢复也失败了：${errorDetail(error).slice(0, 300)}` }));
    } finally {
      working.delete(spec.engine);
    }
  };

  /**
   * 换 bridge 不换 CLI. The adapter keys its install on a hash of the whole
   * recipe, bridge script included, and on a new one reinstalls its own pins:
   * a CLI weeks behind the one upgraded here, which the API refuses newer
   * models to (「Claude Code 2.1.276 does not support this model」) until the
   * next upgrade tick. When the recipe pins nothing newer than what is
   * installed and every other dependency exactly as it is, what it would change
   * is its bridge; that is written here, with the marker, and the adapter
   * finds itself installed. Anything else is left for the adapter to install.
   */
  const adoptRecipe = async (spec: RuntimeSpec): Promise<void> => {
    if (options.bootstrapRecipe == null || working.has(spec.engine)) return;
    const recipe = await options.bootstrapRecipe(spec.engine);
    const prefix = `${spec.bootstrapDir.split(/[\\/]/).join("/")}/`;
    if (recipe == null || `${recipe.bootstrapDir}/` !== prefix) return;
    const identity = bootstrapIdentity(recipe);
    const marker = join(dirOf(spec), `.bootstrap-${identity}.ok`);
    if (await stat(marker).catch(() => undefined)) return;

    const names = recipe.files.map((file) => (file.path.startsWith(prefix) ? file.path.slice(prefix.length) : ""));
    if (names.some((name) => name === "" || name.includes("/") || name.includes("\\") || name.startsWith("."))) return;
    const manifest = recipe.files.find((file) => file.path === `${prefix}package.json`);
    const dependenciesOf = (value: unknown): Record<string, string> | undefined =>
      isRecord(value) && isRecord(value.dependencies) ? (value.dependencies as Record<string, string>) : undefined;
    let wanted: Record<string, string> | undefined;
    try {
      wanted = dependenciesOf(manifest == null ? undefined : JSON.parse(manifest.content));
    } catch {
      return;
    }
    const current = dependenciesOf(await readJson(join(dirOf(spec), "package.json")));
    const installed = await installedSet(spec);
    if (wanted == null || current == null || installed == null) return;
    for (const name of spec.packages) {
      const pinned = wanted[name];
      const have = installed[name];
      if (pinned == null || have == null || compareVersions(have, pinned) < 0) return;
    }
    const rest = (deps: Record<string, string>): string =>
      JSON.stringify(Object.entries(deps).filter(([name]) => !spec.packages.includes(name)).sort(([a], [b]) => a.localeCompare(b)));
    if (rest(wanted) !== rest(current)) return;

    for (const file of recipe.files) {
      const name = file.path.slice(prefix.length);
      if ((PROJECT_FILES as readonly string[]).includes(name)) continue;
      await writeFile(join(dirOf(spec), name), file.content, { mode: 0o600 });
    }
    await writeFile(marker, "", { mode: 0o600 });
    const pinned = wanted[spec.primary] ?? "?";
    log.info(`${spec.label} 的 bridge 换了，沿用已装的 ${installed[spec.primary]}，不退回 ${pinned}`);
    await record(spec, `adopt ${spec.label} recipe ${identity}: new bridge, kept ${installed[spec.primary]} instead of reinstalling ${pinned}`);
  };

  const recoverAll = async (): Promise<void> => {
    for (const spec of SPECS) {
      await recoverOne(spec).catch((error) => log.error(`恢复 ${spec.label} 失败`, error));
      await adoptRecipe(spec).catch((error) => log.error(`接管 ${spec.label} 的新 bridge 失败`, error));
    }
  };

  const must = (engine: string): RuntimeSpec => {
    const spec = specOf(engine);
    if (spec == null) throw new VgentServerError({ message: `${engine} 没有可升级的运行时`, status: 404, code: "runtime_unknown_engine" });
    return spec;
  };

  return {
    recover: recoverAll,

    async status() {
      await recoverAll();
      return Promise.all(SPECS.map(describe));
    },

    async check() {
      await recoverAll();
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
      // A late result from the old installation must not validate the new one
      // or remove its fallback while an upgrade is preparing/swapping files.
      if (spec == null || working.has(spec.engine)) return;
      if (outcome.ok) {
        working.add(spec.engine);
        try {
          if ((await readState(spec)).unverified !== true) return;
          await updateState(spec, ({ unverified: _flag, previous: _previous, ...current }) => current);
          await rm(backupDir(spec), { recursive: true, force: true }).catch((error) => log.warn(`清理 ${spec.label} 旧版失败`, error));
          await pnpm(spec, ["store", "prune"]).catch((error) => log.warn(`清理 ${spec.label} 的旧版本缓存失败`, error));
        } finally {
          working.delete(spec.engine);
        }
        return;
      }
      const state = await readState(spec);
      if (state.unverified !== true) return;
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
      await recoverAll();
      for (const spec of SPECS) {
        try {
          await checkOne(spec);
          const status = await describe(spec);
          if (!status.updateAvailable || status.busy || status.working || status.broken) continue;
          if (status.latest != null && status.bad.includes(status.latest)) continue;
          // Once is a quit at the wrong moment. Twice is something about this
          // machine, and retrying at every start would only break it again.
          if (status.latest != null && ((await readState(spec)).interrupted?.[status.latest] ?? 0) >= 2) continue;
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
