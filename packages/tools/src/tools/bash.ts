import { tool } from "ai";
import { z } from "zod";
import { truncateKeepingEnds } from "../output.js";

/** Shape shared by `Experimental_SandboxSession.run` and the local runner, so the tool treats both identically. */
export interface Runner {
  run(options: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export interface BashToolDeps {
  runner: Runner;
  workDir: string;
  /** Resolves and validates `working_directory` against the working directory. */
  resolveDir: (path: string) => Promise<string>;
  maxOutputChars: number;
}

export function createBashTool({ runner, workDir, resolveDir, maxOutputChars }: BashToolDeps) {
  return tool({
    description:
      "Run a shell command in the working directory and return its output. " +
      `Defaults to a ${DEFAULT_TIMEOUT_MS}ms timeout (max ${MAX_TIMEOUT_MS}ms); output is truncated ` +
      `to ${maxOutputChars} characters, keeping the start and the end.`,
    inputSchema: z.object({
      command: z.string().min(1).describe("The shell command to execute via `/bin/sh -c`."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, capped at ${MAX_TIMEOUT_MS}.`),
      working_directory: z
        .string()
        .optional()
        .describe("Working directory for the command, relative to the task working directory. Defaults to the working directory."),
    }),
    outputSchema: z.object({
      exitCode: z.number().describe("The command's exit code."),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean().describe("True when stdout or stderr was truncated."),
      durationMs: z.number(),
    }),
    execute: async ({ command, timeout_ms, working_directory }, { abortSignal }) => {
      const timeoutMs = Math.min(timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const cwd = working_directory ? await resolveDir(working_directory) : workDir;

      const controller = new AbortController();
      const forwardAbort = () => controller.abort(abortSignal?.reason);
      if (abortSignal) {
        if (abortSignal.aborted) forwardAbort();
        else abortSignal.addEventListener("abort", forwardAbort, { once: true });
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException(`Command timed out after ${timeoutMs}ms`, "TimeoutError"));
      }, timeoutMs);

      const start = Date.now();
      try {
        const result = await runner.run({ command, workingDirectory: cwd, abortSignal: controller.signal });
        const stdout = truncateKeepingEnds(result.stdout, maxOutputChars);
        const stderr = truncateKeepingEnds(result.stderr, maxOutputChars);
        return {
          exitCode: result.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        if (timedOut) throw new Error(`Command timed out after ${timeoutMs}ms: ${command}`);
        throw error;
      } finally {
        clearTimeout(timer);
        if (abortSignal) abortSignal.removeEventListener("abort", forwardAbort);
      }
    },
  });
}
