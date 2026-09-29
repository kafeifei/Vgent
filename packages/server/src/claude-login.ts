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
