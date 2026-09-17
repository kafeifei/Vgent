import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessAgent, type HarnessAgentPermissionMode, type HarnessAgentSession, type HarnessAgentSkill } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { toTUIAgent, type TUIAgent } from "./to-tui-agent.js";

export interface ClaudeCodeEngineOptions {
  /** Repository the agent works in. Becomes the harness session working directory. */
  repoPath: string;
  /**
   * Directory the sandbox runs in, holding the bridge bootstrap and run data.
   * Defaults to `~/.vgent/harness/claude-code`. Never the user's repository:
   * the adapter installs `.harness-bootstrap/` and `.agent-runs/` under it.
   */
  dataDir?: string;
  /** Built-in tool permission mode. Defaults to `allow-edits`. */
  permissionMode?: HarnessAgentPermissionMode;
  /** Harness-specific model identifier. Defaults to the runtime's own default. */
  model?: string;
  /** AI SDK tools executed in this host process when Claude calls them. */
  tools?: ToolSet;
  /** Instruction bundles surfaced to the runtime. */
  skills?: readonly HarnessAgentSkill[];
}

export interface ClaudeCodeEngine {
  /** AI SDK `Agent` with the engine's single harness session bound in. */
  agent: TUIAgent;
  session: HarnessAgentSession;
  dispose(): Promise<void>;
}

export const DEFAULT_CLAUDE_CODE_DATA_DIR = join(homedir(), ".vgent", "harness", "claude-code");

/**
 * Directory holding a `pnpm` executable. The adapter's bootstrap runs
 * `pnpm install --frozen-lockfile`, and the sandbox inherits no PATH from this
 * process, so the directory has to be put on it explicitly.
 */
function resolvePnpmDir(): string {
  const found = execFileSync("/bin/sh", ["-c", "command -v pnpm || true"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (found) return dirname(found);
  throw new Error("pnpm was not found on PATH; the Claude Code bridge bootstrap needs it.");
}

async function ensureDirectory(path: string, mode?: number): Promise<string> {
  await mkdir(path, { recursive: true, ...(mode != null ? { mode } : {}) });
  return path;
}

/**
 * Claude Code as an AI SDK `Agent`, driven by the official harness adapter over
 * a host-local sandbox.
 *
 * - The sandbox runs in `dataDir`, not in the repository: the adapter writes its
 *   bridge bootstrap and per-session run data under the sandbox's default
 *   working directory, which must stay Vgent-owned.
 * - `repoPath` reaches the runtime as `sessionWorkDir`. `HarnessAgent` always
 *   composes that path underneath the sandbox directory, so the adapter is
 *   wrapped to override it.
 * - The sandbox keeps the caller's real `HOME`. `auth: 'auto'` reuses the
 *   machine's existing Claude Code login (`~/.claude`, macOS keychain), and the
 *   `claude` CLI reads its settings from the same place.
 * - The sandbox has no request-transformation proxy, so the adapter forwards the
 *   real credential into the bridge environment and warns about it. Nothing in
 *   this module logs the environment it builds.
 */
export async function createClaudeCodeEngine(options: ClaudeCodeEngineOptions): Promise<ClaudeCodeEngine> {
  const repoPath = resolve(options.repoPath);
  if (!(await stat(repoPath).catch(() => null))?.isDirectory()) {
    throw new Error(`Claude Code engine repoPath is not a directory: ${repoPath}`);
  }
  const dataDir = await ensureDirectory(resolve(options.dataDir ?? DEFAULT_CLAUDE_CODE_DATA_DIR), 0o700);

  const sandbox = createLocalSandboxProvider({
    cwd: dataDir,
    // `node` for the bridge, `pnpm` for its bootstrap install.
    pathExtensions: [dirname(process.execPath), resolvePnpmDir()],
    env: {
      HOME: homedir(),
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    // The bridge binds port 0 and reports the port it actually got.
    allowDynamicPorts: true,
    loopbackOnly: true,
  });

  const harness = createClaudeCode({
    auth: "auto",
    port: 0,
    env: {
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });

  // `HarnessAgent` always composes `sessionWorkDir` underneath the sandbox's
  // default working directory, and `sandboxConfig.workDir` must stay inside it.
  // Overriding the adapter entry point is the only way to point the runtime at
  // a repository outside the sandbox directory.
  const scopedHarness: typeof harness = {
    ...harness,
    doStart: startOptions => harness.doStart({ ...startOptions, sessionWorkDir: repoPath }),
  };

  const agent = new HarnessAgent({
    id: "vgent-claude-code",
    harness: scopedHarness,
    sandbox,
    permissionMode: options.permissionMode ?? "allow-edits",
    ...(options.model != null ? { model: options.model } : {}),
    ...(options.tools != null ? { tools: options.tools } : {}),
    ...(options.skills != null ? { skills: options.skills } : {}),
  });

  const session = await agent.createSession();

  return {
    agent: toTUIAgent({ agent, session }),
    session,
    dispose: () => session.destroy(),
  };
}
