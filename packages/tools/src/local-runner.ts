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
import { Transform } from "node:stream";
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

/**
 * Most bytes a command may print on one stream before it is stopped. The model
 * sees a few thousand characters of it; the rest is only a file on disk, and
 * an unattended `cat /dev/zero` would otherwise fill the disk before its
 * timeout. The file keeps the first `maxOutputBytes`.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Without a storage directory nothing is written to disk, so the in-memory view is all there is. */
const FALLBACK_VIEW_CHARS = 1_000_000;

/** Passes on at most `limit` bytes and swallows the rest, so the pipe keeps draining. */
function byteLimit(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const room = limit - seen;
      seen += chunk.length;
      callback(null, room <= 0 ? undefined : room >= chunk.length ? chunk : chunk.subarray(0, room));
    },
  });
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface LocalRunnerStorage {
  outputDir: string;
  maxOutputChars: number;
  /** Per stream; defaults to 64 MiB. */
  maxOutputBytes?: number;
}

/** Creates a runner whose commands default to `defaultCwd` when no `workingDirectory` is given. */
export function createLocalRunner(defaultCwd: string, storage?: LocalRunnerStorage): LocalRunner {
  return {
    run: (options) => runLocal(defaultCwd, options, storage),
  };
}

async function runLocal(
  defaultCwd: string,
  options: LocalRunOptions,
  storage?: LocalRunnerStorage,
): Promise<LocalRunResult> {
  const { command, workingDirectory, env, abortSignal } = options;
  const maxOutputBytes = storage?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const viewChars = storage?.maxOutputChars ?? FALLBACK_VIEW_CHARS;
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
    if (stdoutFile) child.stdout.pipe(byteLimit(maxOutputBytes)).pipe(stdoutFile);
    if (stderrFile) child.stderr.pipe(byteLimit(maxOutputBytes)).pipe(stderrFile);
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

    // A command that has printed more than the limit is a runaway: stop it the
    // way an abort does, and say so in what the model reads.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimited = false;
    const limitOutput = () => {
      if (outputLimited) return;
      outputLimited = true;
      outputTruncated = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 250);
    };

    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      if (killTimer && !abortSignal?.aborted) clearTimeout(killTimer);
      else killTimer?.unref();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) limitOutput();
      const view = truncateKeepingEnds(stdout + chunk.toString("utf8"), viewChars);
      stdout = view.text;
      outputTruncated ||= view.truncated;
      options.onOutput?.({ stdout, stderr });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) limitOutput();
      const view = truncateKeepingEnds(stderr + chunk.toString("utf8"), viewChars);
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
      if (outputLimited) {
        const limit = maxOutputBytes >= 1024 * 1024 ? `${Math.round(maxOutputBytes / (1024 * 1024))} MiB` : `${Math.round(maxOutputBytes / 1024)} KiB`;
        const note = `[Output exceeded ${limit}; the command was terminated.]`;
        stderr = truncateKeepingEnds(`${stderr}\n${note}`, viewChars).text;
      }
      resolvePromise({
        exitCode: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
        ...(outputFiles ? { outputFiles } : {}),
        ...(outputFiles || outputTruncated ? { outputTruncated } : {}),
      });
    });
  });
}
