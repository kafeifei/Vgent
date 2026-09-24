import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeCommand, claudeLoginEnv } from "./claude-login.js";
import type { SubscriptionId } from "./subscriptions.js";

const execFileAsync = promisify(execFile);

async function codexCommand(): Promise<string> {
  for (const candidate of [join(homedir(), ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next official CLI installation. */ }
  }
  return "codex";
}

export async function logoutSubscription(
  id: SubscriptionId,
  options: {
    env?: NodeJS.ProcessEnv;
    command?: (id: SubscriptionId) => Promise<string>;
    run?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
  } = {},
): Promise<void> {
  const command = await (options.command ?? ((account) => account === "claude-subscription" ? claudeCommand() : codexCommand()))(id);
  const args = id === "claude-subscription" ? ["auth", "logout"] : ["logout"];
  const env = claudeLoginEnv(options.env ?? process.env);
  const run = options.run ?? (async (executable, commandArgs, commandEnv) => {
    await execFileAsync(executable, commandArgs, { env: commandEnv, timeout: 15_000, maxBuffer: 64 * 1024 });
  });
  await run(command, args, env);
}
