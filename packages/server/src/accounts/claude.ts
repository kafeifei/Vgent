import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { claudeCommand, claudeLoginEnv } from "../claude-login.js";
import { probeClaudeLogin, type ClaudeLoginStatus } from "../subscriptions.js";
import { authorizationLink, runCliLogin, type CliLogin } from "./cli-login.js";
import { accountHome } from "./registry.js";
import { isDefaultAccount } from "./spec.js";
import type { AccountId } from "./types.js";
import { object, UsageError } from "./usage.js";

/**
 * A Claude account other than the machine's own login is a Claude Code config
 * directory of its own (`CLAUDE_CONFIG_DIR`): the CLI keeps that login in a
 * keychain item of its own, named after the directory, and `claude auth
 * login` / `logout` there touch nothing else.
 *
 * Only the login is kept apart. What the user set up in `~/.claude` — settings,
 * CLAUDE.md, skills, plugins — and the conversation files (`projects`, which
 * `claude --resume` reads, so a task can move between accounts) are linked in.
 * The CLI's own bookkeeping (`.claude.json`, where the signed-in account is
 * recorded; `backups`, which it restores that file from) must stay separate.
 */
const SHARED = [
  "settings.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "skills",
  "plugins",
  "hooks",
  "output-styles",
  "projects",
  "file-history",
  "todos",
  "plans",
  "keybindings.json",
] as const;

/** The directories that have to exist to be shared: another account writes there. */
const ALWAYS_SHARED = new Set(["projects", "file-history", "todos"]);

const userClaudeDir = () => join(homedir(), ".claude");

/** Creates the account's directory and links in what every account shares. Safe to repeat. */
export async function prepareClaudeHome(home: string, shared = userClaudeDir()): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const name of SHARED) {
    const target = join(shared, name);
    if (ALWAYS_SHARED.has(name)) await mkdir(target, { recursive: true, mode: 0o700 });
    else if (!(await lstat(target).then(() => true, () => false))) continue;
    const link = join(home, name);
    // Whatever is already there — a link, or the CLI's own file — stays.
    if (await lstat(link).then(() => true, () => false)) continue;
    await symlink(target, link).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

/** The config directory an account runs with; the machine's login has none. */
export function claudeHomeOf(dataDir: string, id: AccountId): string | undefined {
  return isDefaultAccount(id) ? undefined : resolve(accountHome(dataDir, id)).normalize("NFC");
}

/** The environment Claude Code runs under for this account. Prepares the directory on the way. */
export async function claudeAccountEnv(dataDir: string, id: AccountId): Promise<Record<string, string>> {
  const home = claudeHomeOf(dataDir, id);
  if (home == null) return {};
  await prepareClaudeHome(home);
  return { CLAUDE_CONFIG_DIR: home };
}

/** The machine's login is whatever this process was started with — normally the default directory. */
const withHome = (home: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  home != null ? { ...env, CLAUDE_CONFIG_DIR: home } : env;

export const probeClaudeAccount = (home: string | undefined, probe: (env?: NodeJS.ProcessEnv) => Promise<ClaudeLoginStatus> = probeClaudeLogin): Promise<ClaudeLoginStatus> =>
  probe(withHome(home));

/**
 * The keychain item Claude Code keeps a login in: `Claude Code-credentials`
 * for the default directory, and for any other one the same name followed by
 * the first eight hex digits of the directory's SHA-256 (read out of the CLI).
 */
export function claudeKeychainService(home: string | undefined): string {
  return home == null ? "Claude Code-credentials" : `Claude Code-credentials-${createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/** Read the same CLI store; never copy, persist, or refresh Claude credentials. */
const keychainRetryAfter = new Map<string, number>();
export async function readClaudeUsageToken(account: string | undefined): Promise<string | undefined> {
  const custom = account ?? process.env.CLAUDE_CONFIG_DIR;
  const home = custom == null ? undefined : resolve(custom).normalize("NFC");
  const service = claudeKeychainService(home);
  let text: string | undefined;
  if (process.platform === "darwin" && Date.now() >= (keychainRetryAfter.get(service) ?? 0)) {
    text = await promisify(execFile)("/usr/bin/security", ["find-generic-password", "-s", service, "-a", userInfo().username, "-w"], { timeout: 8_000, maxBuffer: 512 * 1024 })
      .then((result) => result.stdout)
      .catch(() => { keychainRetryAfter.set(service, Date.now() + 5 * 60_000); return undefined; });
  }
  text ??= await readFile(join(home ?? userClaudeDir(), ".credentials.json"), "utf8").catch(() => undefined);
  if (!text) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return undefined; }
  const oauth = object(object(raw).claudeAiOauth);
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) throw new UsageError(401);
  return typeof oauth.accessToken === "string" ? oauth.accessToken : undefined;
}

/** `claude auth login --claudeai` for this directory. */
export async function startClaudeLogin(home: string | undefined, changed?: () => void): Promise<CliLogin> {
  if (home != null) await prepareClaudeHome(home);
  return runCliLogin({
    command: await claudeCommand(),
    args: ["auth", "login", "--claudeai"],
    env: claudeLoginEnv(withHome(home)),
    match: (output) => authorizationLink(output, ["claude.ai", "platform.claude.com", "console.anthropic.com"], "/oauth/authorize"),
    ...(changed != null ? { changed } : {}),
  });
}

export async function logoutClaude(home: string | undefined): Promise<void> {
  await promisify(execFile)(await claudeCommand(), ["auth", "logout"], { env: claudeLoginEnv(withHome(home)), timeout: 15_000, maxBuffer: 64 * 1024 });
}
