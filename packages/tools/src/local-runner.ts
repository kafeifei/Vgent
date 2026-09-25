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
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { truncateKeepingEnds } from "./output.js";
import { spawn } from "node:child_process";

export interface LocalRunOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  onOutput?: (output: { stdout: string; stderr: string }) => void;
}

export interface LocalRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFiles?: { stdout: string; stderr: string };
  outputTruncated?: boolean;
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
export function createLocalRunner(defaultCwd: string, storage?: { outputDir: string; maxOutputChars: number }): LocalRunner {
  return {
    run: (options) => runLocal(defaultCwd, options, storage),
  };
}

async function runLocal(
  defaultCwd: string,
  options: LocalRunOptions,
  storage?: { outputDir: string; maxOutputChars: number },
): Promise<LocalRunResult> {
  const { command, workingDirectory, env, abortSignal } = options;
  if (abortSignal?.aborted) {
    return Promise.reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  if (storage) await mkdir(storage.outputDir, { recursive: true, mode: 0o700 });
  abortSignal?.throwIfAborted();
  const id = randomUUID();
  const outputFiles = storage
    ? { stdout: join(storage.outputDir, `${id}.stdout.log`), stderr: join(storage.outputDir, `${id}.stderr.log`) }
    : undefined;
  return new Promise<LocalRunResult>((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: workingDirectory ?? defaultCwd,
      env: { ...baseEnv(), ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutFile = outputFiles ? createWriteStream(outputFiles.stdout, { mode: 0o600 }) : undefined;
    const stderrFile = outputFiles ? createWriteStream(outputFiles.stderr, { mode: 0o600 }) : undefined;
    const disk = Promise.all([stdoutFile, stderrFile].filter((stream) => stream != null).map((stream) => finished(stream!)));
    void disk.catch((error) => {
      killGroup("SIGTERM");
      reject(error);
    });
    if (stdoutFile) child.stdout.pipe(stdoutFile);
    if (stderrFile) child.stderr.pipe(stderrFile);
    let outputTruncated = false;
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
      if (killTimer && !abortSignal?.aborted) clearTimeout(killTimer);
      else killTimer?.unref();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const view = truncateKeepingEnds(stdout + chunk.toString("utf8"), storage?.maxOutputChars ?? Number.MAX_SAFE_INTEGER);
      stdout = view.text;
      outputTruncated ||= view.truncated;
      options.onOutput?.({ stdout, stderr });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const view = truncateKeepingEnds(stderr + chunk.toString("utf8"), storage?.maxOutputChars ?? Number.MAX_SAFE_INTEGER);
      stderr = view.text;
      outputTruncated ||= view.truncated;
      options.onOutput?.({ stdout, stderr });
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdoutFile?.end();
      stderrFile?.end();
      reject(error);
    });
    child.once("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await disk;
      } catch (error) {
        reject(error);
        return;
      }
      if (abortSignal?.aborted) {
        reject(abortSignal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      resolvePromise({ exitCode: code ?? (signal ? 128 : 1), stdout, stderr, ...(outputFiles ? { outputFiles, outputTruncated } : {}) });
    });
  });
}
