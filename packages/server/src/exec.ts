/**
 * The one `execFile` wrapper everything that shells out to `git` / `gh` uses.
 *
 * A non-zero exit is a result, not a rejection, because every caller branches
 * on it. Injectable as `ToolExec` so tests can answer for a command without a
 * network or a login.
 */
import { execFile } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;

export interface ExecOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type ToolExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<ExecOutcome>;

export const runCommand: ToolExec = (file, args, options) =>
  new Promise((done) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", ...options.env },
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        if (failure == null) return done({ code: 0, stdout, stderr });
        if (failure.code === "ENOENT") return done({ code: 127, stdout, stderr: `找不到可执行文件: ${file}` });
        if (failure.killed === true) return done({ code: 124, stdout, stderr: `${file} 超时（${options.timeout}ms）` });
        return done({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr: stderr || failure.message });
      },
    );
  });
