import { spawn as spawnChild } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import type {
  Experimental_SandboxProcess as SandboxProcess,
  Experimental_SandboxSession as SandboxSession,
} from "@ai-sdk/provider-utils";

export interface LocalSandboxOptions {
  id: string;
  /** Existing local directory. This adapter is a host process runner, not an OS sandbox. */
  cwd: string;
  /** Deliberately forwarded environment only; process.env is never copied wholesale. */
  env?: Readonly<Record<string, string>>;
  /** Directories prepended to the default PATH, for tool binaries the caller needs. */
  pathExtensions?: readonly string[];
  ports?: readonly number[];
  /** Codex binds port 0 and reports the chosen port. Only enable for trusted bridge adapters. */
  allowDynamicPorts?: boolean;
  /**
   * Force every TCP server started inside this session to bind loopback, by
   * preloading `loopback-preload.js` through NODE_OPTIONS. Defaults to true.
   */
  loopbackOnly?: boolean;
  /** Maximum captured bytes per stream for run(); spawn() streams with backpressure. */
  maxOutputBytes?: number;
  /** Grace period before SIGKILL; stop/kill still await process exit after escalation. */
  terminateGraceMs?: number;
}

type ProcessOptions = Parameters<SandboxSession["spawn"]>[0];
type ExitResult = { exitCode: number };
type OwnedProcess = { terminate(): Promise<void> };

function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Local bridge port must be an integer between 1024 and 65535.");
  }
}

function encoding(value = "utf-8"): BufferEncoding {
  if (!Buffer.isEncoding(value)) throw new Error(`Unsupported text encoding: ${value}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

/**
 * URL of the compiled loopback preload. Resolved at runtime so it works both
 * from `dist/` (sibling file) and from `src/` under vitest (built sibling in
 * `dist/`). A file URL survives paths containing spaces, which a bare
 * NODE_OPTIONS argument would not.
 */
export function loopbackPreloadUrl(): string {
  const candidates = [
    new URL("./loopback-preload.js", import.meta.url),
    new URL("../dist/loopback-preload.js", import.meta.url),
  ];
  const found = candidates.find(candidate => existsSync(candidate));
  if (found == null) {
    throw new Error("Loopback preload is not built; run `pnpm build` in @vgent/sandbox-local.");
  }
  return found.href;
}

function withLoopbackPreload(nodeOptions: string | undefined): string {
  const preload = `--import=${loopbackPreloadUrl()}`;
  if (nodeOptions == null || nodeOptions.trim() === "") return preload;
  if (nodeOptions.includes(preload)) return nodeOptions;
  return `${nodeOptions} ${preload}`;
}

/** No login shell, shell init files, credential variables, or NODE_OPTIONS are inherited. */
export function localProcessEnvironment(
  explicit: Readonly<Record<string, string>> = {},
  pathExtensions: readonly string[] = [],
): NodeJS.ProcessEnv {
  const path = [...pathExtensions, dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return {
    PATH: path.join(":"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...explicit,
  };
}

/**
 * A local implementation of the SDK's sandbox interface, without OS isolation.
 * Absolute paths and symlinks retain normal host semantics. Tool permission
 * enforcement belongs to the harness/tool layer. This object never removes
 * workspaces or kills any process it did not spawn.
 */
export async function createLocalSandboxSession(
  options: LocalSandboxOptions,
): Promise<HarnessV1NetworkSandboxSession> {
  if (!options.id.trim()) throw new Error("Local sandbox session id must not be empty.");
  const cwd = await realpath(options.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error("Local sandbox working directory must be a directory.");
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const terminateGraceMs = options.terminateGraceMs ?? 750;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("maxOutputBytes must be a positive integer.");
  }
  if (!Number.isFinite(terminateGraceMs) || terminateGraceMs < 0) {
    throw new Error("terminateGraceMs must be a non-negative number.");
  }
  const loopbackOnly = options.loopbackOnly ?? true;
  const baseEnv = localProcessEnvironment(options.env, options.pathExtensions);
  if (loopbackOnly) baseEnv.NODE_OPTIONS = withLoopbackPreload(baseEnv.NODE_OPTIONS);
  let ports = new Set(options.ports ?? []);
  ports.forEach(validatePort);
  const owned = new Set<OwnedProcess>();
  let stopped = false;
  let stopping: Promise<void> | undefined;

  function assertActive(signal?: AbortSignal): void {
    checkAbort(signal);
    if (stopped) throw new Error("Local sandbox session is stopped; create a new session to continue.");
  }

  const localPath = (path: string) => resolve(cwd, path);

  const spawn: SandboxSession["spawn"] = async (input: ProcessOptions): Promise<SandboxProcess> => {
    assertActive(input.abortSignal);
    const processCwd = await realpath(localPath(input.workingDirectory ?? "."));
    assertActive(input.abortSignal);
    const env = { ...baseEnv, ...input.env };
    // Per-call env must not be able to drop the loopback preload.
    if (loopbackOnly) env.NODE_OPTIONS = withLoopbackPreload(env.NODE_OPTIONS);
    const child = spawnChild("/bin/sh", ["-c", input.command], {
      cwd: processCwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let spawnError: Error | undefined;
    let aborted = false;
    let abortReason: unknown;
    let terminating: Promise<void> | undefined;
    let orphanMonitor: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let settleClose!: (result: ExitResult) => void;
    const exited = new Promise<ExitResult>(resolveExit => {
      settleClose = resolveExit;
    });
    const groupExists = () => {
      if (child.pid == null) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        // EPERM establishes existence, not absence. A dying orphan group may
        // transiently be unsignalable while the OS reaps it; keep waiting.
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        throw error;
      }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        // Persistent EPERM still fails the bounded group-exit check below.
      }
    };
    const record: OwnedProcess = {
      terminate() {
        return (terminating ??= (async () => {
          if (!owned.has(record)) return;
          signalGroup("SIGTERM");
          const graceDeadline = Date.now() + terminateGraceMs;
          while (groupExists() && Date.now() < graceDeadline) await delay(20);
          if (groupExists()) signalGroup("SIGKILL");
          const killDeadline = Date.now() + 3000;
          while ((!closed || groupExists()) && Date.now() < killDeadline) await delay(20);
          if (!closed || groupExists()) {
            throw new Error(`Local process ${child.pid ?? "unknown"} did not exit within the stop deadline.`);
          }
          await exited;
          if (orphanMonitor) clearInterval(orphanMonitor);
          owned.delete(record);
        })());
      },
    };
    owned.add(record);
    const onAbort = () => {
      aborted = true;
      abortReason = input.abortSignal?.reason;
      // wait() below observes this same cleanup promise; prevent an unhandled
      // rejection when a caller attaches wait only after reading stdout.
      void record.terminate().catch(() => {});
    };
    child.once("error", error => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      closed = true;
      input.abortSignal?.removeEventListener("abort", onAbort);
      settleClose({ exitCode: code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1) });
      // A shell may exit while its background process remains in our group.
      // Keep that group registered until stop(), even if stdio was redirected.
      if (!groupExists()) owned.delete(record);
      else if (!terminating) {
        // Drop groups that finish on their own, instead of retaining stale
        // group ids for the lifetime of a long-lived harness session.
        orphanMonitor = setInterval(() => {
          if (!groupExists()) {
            clearInterval(orphanMonitor);
            owned.delete(record);
          }
        }, 100);
        orphanMonitor.unref();
      }
    });
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (input.abortSignal?.aborted) onAbort();
    const wait = async () => {
      const result = await exited;
      if (terminating) await terminating;
      if (aborted) throw abortReason;
      if (spawnError) throw spawnError;
      return result;
    };
    return {
      ...(child.pid != null ? { pid: child.pid } : {}),
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      wait,
      kill: () => record.terminate(),
    };
  };

  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxOutputBytes) throw new Error(`Local command output exceeded the ${maxOutputBytes} byte limit.`);
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      reader.releaseLock();
    }
  };

  const readBinaryFile: SandboxSession["readBinaryFile"] = async input => {
    assertActive(input.abortSignal);
    try {
      return await readFile(localPath(input.path), { signal: input.abortSignal });
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const writeFile: SandboxSession["writeFile"] = async input => {
    assertActive(input.abortSignal);
    const filePath = localPath(input.path);
    await mkdir(dirname(filePath), { recursive: true });
    assertActive(input.abortSignal);
    // Node's and DOM's BYOB stream declarations differ with the shared-buffer
    // lib types; both represent the same native Web Stream at runtime.
    await pipeline(
      Readable.fromWeb(input.content as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(filePath, { mode: 0o600 }),
      { signal: input.abortSignal },
    );
  };
  const writeBinaryFile: SandboxSession["writeBinaryFile"] = input =>
    writeFile({
      ...input,
      content: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(input.content);
          controller.close();
        },
      }),
    });

  const basic: SandboxSession = {
    description: `Local host: ${cwd}. Processes run with the current user's privileges; this is not an OS sandbox.`,
    readFile: async input => {
      assertActive(input.abortSignal);
      const filePath = localPath(input.path);
      try {
        await stat(filePath);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      return Readable.toWeb(
        createReadStream(filePath, { signal: input.abortSignal }),
      ) as ReadableStream<Uint8Array>;
    },
    readBinaryFile,
    readTextFile: async input => {
      const selectedEncoding = encoding(input.encoding);
      for (const line of [input.startLine, input.endLine]) {
        if (line != null && (!Number.isSafeInteger(line) || line < 1)) {
          throw new Error("Text line numbers must be integers starting at 1.");
        }
      }
      if (input.startLine != null && input.endLine != null && input.endLine < input.startLine) {
        throw new Error("End line number must not be smaller than the start line number.");
      }
      const bytes = await readBinaryFile(input);
      if (bytes == null) return null;
      const text = Buffer.from(bytes).toString(selectedEncoding);
      if (input.startLine == null && input.endLine == null) return text;
      return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).slice((input.startLine ?? 1) - 1, input.endLine).join("");
    },
    writeFile,
    writeBinaryFile,
    writeTextFile: input => writeBinaryFile({ ...input, content: Buffer.from(input.content, encoding(input.encoding)) }),
    spawn,
    run: async input => {
      const proc = await spawn(input);
      const results = [proc.wait(), capture(proc.stdout), capture(proc.stderr)] as const;
      try {
        const [exit, stdout, stderr] = await Promise.all(results);
        return { ...exit, stdout, stderr };
      } catch (error) {
        await proc.kill();
        await Promise.allSettled(results);
        throw error;
      }
    },
  };
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true;
      const results = await Promise.allSettled([...owned].map(process => process.terminate()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map(result => result.reason),
          `Some local sandbox processes did not exit: ${failures
            .map(result => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
            .join("; ")}`,
        );
      }
      ports.clear();
    })());
  const getPortEndpoint: HarnessV1NetworkSandboxSession["getPortEndpoint"] = async ({ port, protocol = "http" }) => {
    assertActive();
    validatePort(port);
    if (!["http", "https", "ws"].includes(protocol)) throw new Error("Unsupported local bridge protocol.");
    if (!ports.has(port)) {
      if (!options.allowDynamicPorts) throw new Error(`Local bridge port ${port} is not registered.`);
      ports.add(port);
    }
    // Bridge authentication is supplied by the official adapter, not a token
    // inherited from this host process. Never expose a non-loopback endpoint.
    return { url: `${protocol}://127.0.0.1:${port}` };
  };
  return {
    ...basic,
    id: options.id,
    defaultWorkingDirectory: cwd,
    get ports() {
      return Object.freeze([...ports].sort((a, b) => a - b));
    },
    getPortEndpoint,
    getPortUrl: async input => (await getPortEndpoint(input)).url,
    setPorts: async (next, input) => {
      assertActive(input?.abortSignal);
      next.forEach(validatePort);
      ports = new Set(next);
    },
    stop,
    destroy: stop,
    restricted: () => Object.freeze({ ...basic }),
  };
}
