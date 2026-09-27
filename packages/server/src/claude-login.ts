import { execFile, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, userInfo } from "node:os";
import { DEFAULT_CLAUDE_CODE_DATA_DIR } from "@vgent/engines";

/** Use the harness CLI first, including when Finder's PATH cannot find claude. */
export async function claudeCommand(): Promise<string> {
  const candidates = [
    join(DEFAULT_CLAUDE_CODE_DATA_DIR, ".harness-bootstrap/claude-code/node_modules/.bin/claude"),
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next installation, including during a harness upgrade. */ }
  }
  return "claude";
}

export const claudeLoginEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  HOME: homedir(),
  PATH: [dirname(process.execPath), env.PATH].filter(Boolean).join(":"),
  USER: userInfo().username,
  DISABLE_AUTOUPDATER: "1",
});

export interface ClaudeLoginAttempt {
  state: "idle" | "running" | "succeeded" | "failed";
  url?: string;
  error?: string;
}

/** Only expose the official authorization link, never arbitrary CLI output. */
export function authorizationUrl(output: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (["claude.ai", "platform.claude.com", "console.anthropic.com"].includes(url.hostname) && url.pathname === "/oauth/authorize") return url.href;
    } catch { /* A partial output chunk is retried on the next chunk. */ }
  }
  return undefined;
}

export function createClaudeLogin(options: {
  command?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  changed?: () => void;
} = {}) {
  let attempt: ClaudeLoginAttempt = { state: "idle" };
  let child: ChildProcess | undefined;
  let generation = 0;
  const cancel = () => {
    generation++;
    child?.kill("SIGTERM");
    child = undefined;
    attempt = { state: "idle" };
    options.changed?.();
  };
  return {
    status: (): ClaudeLoginAttempt => ({ ...attempt }),
    cancel,
    async start(): Promise<ClaudeLoginAttempt> {
      if (attempt.state === "running") return { ...attempt };
      attempt = { state: "running" };
      options.changed?.();
      const current = ++generation;
      try {
        const command = await (options.command ?? claudeCommand)();
        if (current !== generation) return { ...attempt };
        let output = "";
        child = execFile(command, ["auth", "login", "--claudeai"], {
          env: claudeLoginEnv(options.env ?? process.env),
          timeout: options.timeout ?? 5 * 60_000,
          maxBuffer: 256 * 1024,
        }, (error) => {
          if (current !== generation) return;
          child = undefined;
          options.changed?.();
          attempt = error == null ? { state: "succeeded" } : {
            state: "failed",
            error: (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "找不到 Claude Code，请先安装 Claude Code 后重试。"
              : "登录未完成或已超时，请重试。",
          };
        });
        const read = (chunk: Buffer) => {
          if (current !== generation) return;
          output = (output + chunk.toString()).slice(-32_768);
          const url = authorizationUrl(output);
          if (url != null) attempt = { state: "running", url };
        };
        child.stdout?.on("data", read);
        child.stderr?.on("data", read);
      } catch {
        if (current === generation) attempt = { state: "failed", error: "无法启动 Claude 登录，请重试。" };
      }
      return { ...attempt };
    },
  };
}
