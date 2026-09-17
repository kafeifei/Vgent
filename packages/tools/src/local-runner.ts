/**
 * Minimal command runner used by the `bash` tool when no
 * `Experimental_SandboxSession` is supplied. Deliberately shaped like
 * `SandboxSession["run"]` (`{ command, workingDirectory?, env?, abortSignal? }`
 * -> `{ exitCode, stdout, stderr }`) so the tool can treat a sandbox and this
 * local runner identically.
 *
 * Spawns `/bin/sh -c <command>` in its own process group so an abort can kill
 * the whole subtree, and does not inherit the host environment beyond
 * `PATH`/`HOME`/`LANG`.
 */
import { spawn } from "node:child_process";

export interface LocalRunOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface LocalRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalRunner {
  run(options: LocalRunOptions): Promise<LocalRunResult>;
}

const INHERITED_ENV_KEYS = ["PATH", "HOME", "LANG"] as const;

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Creates a runner whose commands default to `defaultCwd` when no `workingDirectory` is given. */
export function createLocalRunner(defaultCwd: string): LocalRunner {
  return {
    run: (options) => runLocal(defaultCwd, options),
  };
}

function runLocal(defaultCwd: string, options: LocalRunOptions): Promise<LocalRunResult> {
  const { command, workingDirectory, env, abortSignal } = options;
  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise<LocalRunResult>((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: workingDirectory ?? defaultCwd,
      env: { ...baseEnv(), ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The process group may have already exited.
      }
    };

    const onAbort = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (abortSignal?.aborted) {
        reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      resolvePromise({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}
