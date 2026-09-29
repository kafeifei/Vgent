import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describeSubscriptionAuth, getCodexTokenProvider } from "@vgent/providers";
import { authorizationLink, runCliLogin, type CliLogin } from "./cli-login.js";
import { accountHome } from "./registry.js";
import { isDefaultAccount } from "./spec.js";
import type { AccountId } from "./types.js";

/**
 * A Codex account is a Codex home (`CODEX_HOME`): `codex login` there writes
 * that home's `auth.json`, and every consumer — model lists, quota, the native
 * Codex engine, the in-house engine — takes its token from the same home. The
 * machine's own login is the home the CLI uses by default.
 */
export function codexHomeOf(dataDir: string, id: AccountId): string {
  return isDefaultAccount(id) ? resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")) : resolve(accountHome(dataDir, id));
}

export const codexEnvOf = (home: string): NodeJS.ProcessEnv => ({ ...process.env, CODEX_HOME: home });

export const probeCodexAccount = (home: string, probe: typeof describeSubscriptionAuth = describeSubscriptionAuth) => probe({ env: codexEnvOf(home) });

export const codexTokens = (home: string) => getCodexTokenProvider({ env: codexEnvOf(home) });

export async function codexCommand(): Promise<string> {
  for (const candidate of [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next official CLI installation. */ }
  }
  return "codex";
}

/** `codex login` in this home. It serves its callback on localhost and opens the browser itself. */
export async function startCodexLogin(home: string, changed?: () => void): Promise<CliLogin> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return runCliLogin({
    command: await codexCommand(),
    args: ["login"],
    env: codexEnvOf(home),
    match: (output) => authorizationLink(output, ["auth.openai.com"], "/oauth/authorize"),
    ...(changed != null ? { changed } : {}),
  });
}

export async function logoutCodex(home: string): Promise<void> {
  await promisify(execFile)(await codexCommand(), ["logout"], { env: codexEnvOf(home), timeout: 15_000, maxBuffer: 64 * 1024 });
}
