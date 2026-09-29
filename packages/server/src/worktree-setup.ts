/**
 * The project's worktree setup script.
 *
 * A fresh worktree is an empty checkout: no `node_modules`, no build output, so
 * the task cannot run the repo's own tests until the project's setup has run in
 * it. The configuration is Cursor's (`.cursor/worktrees.json`), which this repo
 * also reads from `.vgent/worktrees.json` first, so a project can carry both.
 * A restored worktree is in the same state — 归档 keeps only what git sees —
 * so setup runs again on the way back.
 *
 * Before the setup's commands, `include-files` (Fumie's worktree-include
 * contract) copies the ignored files a project cannot rebuild — a `.env`, a
 * local config — from its checkout. Never `node_modules`: dependencies are
 * the setup's to install.
 *
 * Setup never blocks `POST /api/threads` — the user types their first message
 * while it installs — so its progress lives on the thread record
 * (`workspace.setup`) and `runs.start()` waits for it there.
 */
import { execFile, spawn } from "node:child_process";
import { appendFile, cp, lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ThreadStore } from "./store/threads.js";
import type { Logger, WorkspaceSetup } from "./types.js";
import { silentLogger } from "./types.js";

/** Config files, in the order a project is searched. */
const CONFIG_FILES = [".vgent/worktrees.json", ".cursor/worktrees.json"] as const;
/** Globs of git-ignored files to copy from the project checkout into each worktree. */
const INCLUDE_KEY = "include-files";

const execGit = promisify(execFile);

/** Overall budget for the whole setup, however many commands it runs. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
/** Conventional shell exit code for「被超时杀掉」. */
const TIMEOUT_EXIT_CODE = 124;
/** Setup logs are for reading, not archiving. */
const MAX_LOG_BYTES = 1024 * 1024;
/** How much of the log `GET .../setup-log` returns. */
export const SETUP_LOG_TAIL_BYTES = 200 * 1024;

export const setupLogPath = (dataDir: string, threadId: string): string => join(dataDir, "workspaces", `${threadId}.setup.log`);

/** What a project's config asks for: shell commands, or one script file. */
export type SetupSpec =
  | { kind: "commands"; configPath: string; key: string; commands: string[] }
  | { kind: "script"; configPath: string; key: string; scriptPath: string };

/** Platform-specific key first, then the generic one. */
function keysFor(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["setup-worktree-windows", "setup-worktree"] : ["setup-worktree-unix", "setup-worktree"];
}

function specFrom(config: Record<string, unknown>, configPath: string, platform: NodeJS.Platform): SetupSpec | undefined {
  for (const key of keysFor(platform)) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") {
      // A path relative to the json file itself, per Cursor's schema.
      return { kind: "script", configPath, key, scriptPath: resolve(configPath, "..", value.trim()) };
    }
    if (Array.isArray(value)) {
      const commands = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
      if (commands.length > 0) return { kind: "commands", configPath, key, commands };
    }
  }
  return undefined;
}

/**
 * The setup this project defines, or `undefined`. A file that exists but names
 * no usable key falls through to the next one, so a `.cursor` config still
 * works next to a `.vgent` one that only configures something else.
 */
export async function findSetupSpec(projectPath: string, platform: NodeJS.Platform = process.platform, log: Logger = silentLogger): Promise<SetupSpec | undefined> {
  for (const relative of CONFIG_FILES) {
    const configPath = join(projectPath, relative);
    const raw = await readFile(configPath, "utf8").catch(() => undefined);
    if (raw == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn(`${configPath} 不是合法 JSON，已跳过`, error);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const spec = specFrom(parsed as Record<string, unknown>, configPath, platform);
    if (spec != null) return spec;
  }
  return undefined;
}

const isDependencies = (path: string): boolean => path.toLowerCase().includes("node_modules");

/**
 * The project's `include-files`, from the first config that names any. A rule
 * that reaches into `node_modules` is dropped: a worktree copies small ignored
 * inputs, never a dependency tree.
 */
export async function findIncludeFiles(projectPath: string, log: Logger = silentLogger): Promise<string[]> {
  for (const relative of CONFIG_FILES) {
    const configPath = join(projectPath, relative);
    const raw = await readFile(configPath, "utf8").catch(() => undefined);
    if (raw == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // `findSetupSpec` already says so.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const value = (parsed as Record<string, unknown>)[INCLUDE_KEY];
    if (!Array.isArray(value)) continue;
    const patterns = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
    const kept = patterns.filter((pattern) => !isDependencies(pattern));
    if (kept.length < patterns.length) log.warn(`${configPath} 的 ${INCLUDE_KEY} 里碰 node_modules 的规则已忽略，依赖由 setup 安装`);
    return kept;
  }
  return [];
}

/**
 * Copies the project checkout's ignored files matching `patterns` (git glob
 * pathspecs) into the worktree, leaving alone any path the worktree already
 * has. Returns how many were copied.
 */
export async function copyIncludeFiles(projectPath: string, workspacePath: string, patterns: readonly string[]): Promise<number> {
  if (patterns.length === 0) return 0;
  const { stdout } = await execGit(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...patterns.map((pattern) => `:(glob)${pattern}`)],
    { cwd: projectPath, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
  );
  let copied = 0;
  for (const file of stdout.split("\0")) {
    if (file === "" || isDependencies(file)) continue;
    const target = join(workspacePath, file);
    if (await lstat(target).then(() => true, () => false)) continue;
    await mkdir(dirname(target), { recursive: true });
    await cp(join(projectPath, file), target, { verbatimSymlinks: true, preserveTimestamps: true });
    copied += 1;
  }
  return copied;
}

/** Appends to the setup log until it hits its cap, then says so once. */
function createAppender(path: string) {
  let written = 0;
  let cut = false;
  return async (text: string): Promise<void> => {
    if (cut) return;
    let chunk = text;
    if (written + Buffer.byteLength(chunk) > MAX_LOG_BYTES) {
      chunk = `${chunk.slice(0, Math.max(0, MAX_LOG_BYTES - written))}\n…（日志过长，已截断）\n`;
      cut = true;
    }
    written += Buffer.byteLength(chunk);
    await appendFile(path, chunk).catch(() => {});
  };
}

interface StepOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  append: (text: string) => Promise<void>;
}

/** One `sh` invocation, its whole process group killed if the turn is abandoned. */
function runStep(command: string[], options: StepOptions): Promise<number> {
  return new Promise((done) => {
    // Its own process group, so a `pnpm install` that spawned children dies whole.
    const child = spawn("sh", command, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    if (options.signal.aborted) kill();
    options.signal.addEventListener("abort", kill, { once: true });
    const pump = (stream: NodeJS.ReadableStream | null) => stream?.on("data", (chunk: Buffer) => void options.append(chunk.toString("utf8")));
    pump(child.stdout);
    pump(child.stderr);
    child.on("error", (error) => {
      void options.append(`${error.message}\n`);
      options.signal.removeEventListener("abort", kill);
      done(127);
    });
    child.on("close", (code, signal) => {
      options.signal.removeEventListener("abort", kill);
      done(code ?? (options.signal.aborted ? TIMEOUT_EXIT_CODE : signal != null ? 1 : 0));
    });
  });
}

export interface RunSetupOptions {
  dataDir: string;
  threadId: string;
  /** The fresh worktree: setup's cwd. */
  workspacePath: string;
  /** The project's own checkout, handed over as `ROOT_WORKTREE_PATH`. */
  projectPath: string;
  spec?: SetupSpec;
  /** `include-files` globs, copied before the first command runs. */
  includeFiles?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** How a setup ended: its exit code, and on failure the sentence the user reads. */
export interface SetupResult {
  exitCode: number;
  error?: string;
}

/**
 * Runs the spec's steps in order, stopping at the first failure. The log is
 * the script's output as Cursor keeps it: what the steps printed, each
 * command echoed before it runs so a failed tail says which one it was. The
 * exit code and the reason are returned, not written into it.
 */
export async function runSetup(options: RunSetupOptions): Promise<SetupResult> {
  const path = setupLogPath(options.dataDir, options.threadId);
  await writeFile(path, "", { mode: 0o600 });
  const append = createAppender(path);
  const env = { ...process.env, ROOT_WORKTREE_PATH: options.projectPath };

  const timeout = AbortSignal.timeout(options.timeoutMs ?? SETUP_TIMEOUT_MS);
  const signal = options.signal == null ? timeout : AbortSignal.any([timeout, options.signal]);

  const includeFiles = options.includeFiles ?? [];
  if (includeFiles.length > 0) {
    try {
      await copyIncludeFiles(options.projectPath, options.workspacePath, includeFiles);
    } catch (error) {
      return { exitCode: 1, error: `复制 ${INCLUDE_KEY} 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const spec = options.spec;
  if (spec == null) return { exitCode: 0 };

  const steps: Array<{ echo?: string; argv: string[] }> =
    spec.kind === "script" ? [{ argv: [spec.scriptPath] }] : spec.commands.map((command) => ({ echo: command, argv: ["-c", command] }));
  for (const { echo, argv } of steps) {
    if (echo != null) await append(`$ ${echo}\n`);
    const code = await runStep(argv, { cwd: options.workspacePath, env, signal, append });
    if (code !== 0) {
      return { exitCode: code, error: signal.aborted ? "setup 脚本超时，已终止" : `setup 脚本失败，退出码 ${code}` };
    }
  }
  return { exitCode: 0 };
}

// --- tracking -----------------------------------------------------------

/**
 * Setups in flight in this process. Module-level for the same reason the
 * workspace locks are: `runs.start()` has no other handle on the setup that
 * `POST /api/threads` kicked off.
 */
const inflight = new Map<string, Promise<void>>();

/** Resolves once this thread's setup is over — immediately when there is none. */
export async function whenSetupSettled(threadId: string): Promise<void> {
  await inflight.get(threadId);
}

export interface StartSetupOptions extends Omit<RunSetupOptions, "spec"> {
  /** Persists each transition, so the SSE state carries it to the client. */
  onStatus: (setup: WorkspaceSetup) => Promise<void>;
  log?: Logger;
}

/**
 * Finds the project's setup and runs it in the background. Returns as soon as
 * it is registered: the caller answers the HTTP request, and the turn waits
 * through `whenSetupSettled`.
 */
export function startSetup(options: StartSetupOptions): void {
  const log = options.log ?? silentLogger;
  const task = (async () => {
    const [spec, includeFiles] = await Promise.all([
      findSetupSpec(options.projectPath, process.platform, log),
      findIncludeFiles(options.projectPath, log),
    ]);
    if (spec == null && includeFiles.length === 0) return;
    const startedAt = new Date().toISOString();
    await options.onStatus({ status: "running", startedAt });
    let result: SetupResult;
    try {
      result = await runSetup({ ...options, ...(spec != null ? { spec } : {}), includeFiles });
    } catch (error) {
      log.warn(`工作目录准备失败 (thread ${options.threadId})`, error);
      result = { exitCode: 1, error: `setup 脚本没能运行：${error instanceof Error ? error.message : String(error)}` };
    }
    await options.onStatus({
      status: result.exitCode === 0 ? "ok" : "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      ...(result.error != null ? { error: result.error } : {}),
    });
    if (result.exitCode !== 0) log.warn(`工作目录准备失败 (thread ${options.threadId})，退出码 ${result.exitCode}`);
  })().catch((error: unknown) => log.warn(`工作目录准备出错 (thread ${options.threadId})`, error));

  inflight.set(options.threadId, task);
  void task.finally(() => {
    if (inflight.get(options.threadId) === task) inflight.delete(options.threadId);
  });
}

/** The tail of a thread's setup log, or `""` when it never had one. */
export async function readSetupLog(dataDir: string, threadId: string, tailBytes = SETUP_LOG_TAIL_BYTES): Promise<string> {
  const path = setupLogPath(dataDir, threadId);
  const size = await stat(path).then(
    (info) => info.size,
    () => undefined,
  );
  if (size == null) return "";
  const raw = await readFile(path).catch(() => undefined);
  if (raw == null) return "";
  return raw.subarray(Math.max(0, raw.length - tailBytes)).toString("utf8");
}

/**
 * A `running` setup on disk died with the process that owned it. Marked failed
 * at boot so it can never hold a turn back forever.
 */
export async function failInterruptedSetups(threads: ThreadStore, log: Logger = silentLogger): Promise<void> {
  for (const summary of await threads.list()) {
    const workspace = summary.workspace;
    if (workspace?.setup?.status !== "running") continue;
    await threads
      .update(summary.id, {
        workspace: {
          ...workspace,
          setup: { ...workspace.setup, status: "failed", finishedAt: new Date().toISOString(), error: "setup 脚本因 Vgent 重启中断" },
        },
      })
      .catch((error) => log.warn(`标记线程 ${summary.id} 的工作目录准备失败`, error));
  }
}
