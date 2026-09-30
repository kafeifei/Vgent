import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  HarnessAgent,
  type HarnessAgentContinueTurnState,
  type HarnessAgentPermissionMode,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
  type HarnessAgentSkill,
} from "@ai-sdk/harness/agent";
import { createOpenCode } from "@ai-sdk/harness-opencode";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { ensureDirectory, resolvePnpmDir, resolveRepoPath, trackSandboxSessions, withRepoWorkDir } from "./shared.js";
import { toTUIAgent, type TUIAgent } from "./to-tui-agent.js";

export interface OpenCodeEngineOptions {
  /** Repository the agent works in. Becomes the harness session working directory. */
  repoPath: string;
  /**
   * Directory the sandbox runs in, holding the bridge bootstrap and run data.
   * Defaults to `~/.vgent/harness/opencode`. Never the user's repository: the
   * adapter installs `.harness-bootstrap/` and `.agent-runs/` under it.
   */
  dataDir?: string;
  /** Built-in tool permission mode. Defaults to `allow-edits`. */
  permissionMode?: HarnessAgentPermissionMode;
  /** OpenCode's own `provider/model` id. Unset, OpenCode picks from its own config. */
  model?: string;
  /**
   * OpenCode's reasoning variant for the model (`low`, `high`, …, whatever the
   * model offers). Unset leaves OpenCode's default.
   */
  reasoningVariant?: string;
  /** AI SDK tools executed in this host process when OpenCode calls them. */
  tools?: ToolSet;
  /**
   * The only built-in tools the runtime may call this session, by their harness
   * names (`read`, `grep`, `glob`, `todowrite`, …). The bridge turns every other
   * one into an `ask` permission, which the host then refuses, so this is a real
   * restriction. Unset leaves the whole built-in set available.
   */
  activeTools?: readonly string[];
  /** Extra instructions, sent as the prompt's system text on every turn. */
  instructions?: string;
  /** Instruction bundles surfaced to the runtime. */
  skills?: readonly HarnessAgentSkill[];
  /**
   * Native OpenCode config merged under what the adapter manages (`provider`,
   * `agent.*.model`, …). OpenCode's own global config is still read on top of
   * nothing — see {@link createOpenCodeEngine}.
   */
  openCodeConfig?: Record<string, unknown>;
  /** MCP servers in OpenCode's own format, keyed by name. */
  mcpServers?: Record<string, unknown>;
  /**
   * Credential environment for the adapter (`OPENAI_API_KEY`, …). Defaults to an
   * empty one; see {@link createOpenCodeEngine} for why it is never `'auto'`.
   */
  auth?: Readonly<Record<string, string>>;
  /**
   * Extra environment for the bridge and the `opencode` server it starts —
   * `OPENCODE_AUTH_CONTENT` above all, which replaces OpenCode's own login
   * store for this session. See {@link openCodeAuthContent}.
   */
  env?: Readonly<Record<string, string>>;
  /** Stable identifier for the underlying harness session. */
  sessionId?: string;
  /** Resume payload from a previous `stop()`, paired with the same `sessionId`. */
  resumeFrom?: HarnessAgentResumeSessionState;
  /** Continuation payload from a previous `suspend()`, paired with the same `sessionId`. */
  continueFrom?: HarnessAgentContinueTurnState;
}

export interface OpenCodeEngine {
  /** AI SDK `Agent` with the engine's single harness session bound in. */
  agent: TUIAgent;
  /** The raw `HarnessAgent`, for callers that drive turns themselves. */
  harnessAgent: HarnessAgent<any, any, any, any, any>;
  session: HarnessAgentSession;
  /** Persist resume state, then stop the runtime and the sandbox. */
  stop(): Promise<HarnessAgentResumeSessionState>;
  /** Freeze the unfinished turn and hand back the payload that reattaches to it. */
  suspend(): Promise<HarnessAgentContinueTurnState>;
  dispose(): Promise<void>;
}

export const DEFAULT_OPENCODE_DATA_DIR = join(homedir(), ".vgent", "harness", "opencode");

/** The server's PATH, as the desktop shell hands it over from the login shell. */
function userPath(): string[] {
  return (process.env.PATH ?? "").split(":").filter((entry) => entry !== "");
}

/**
 * `OPENCODE_AUTH_CONTENT` for a ChatGPT login: OpenCode reads its whole login
 * store from this variable when it is set, so the session runs on exactly this
 * account and never on whatever `opencode auth login` left behind. The token is
 * the host's to refresh (`refresh: "host-managed"`, an expiry OpenCode never
 * reaches); every turn starts a fresh bridge with a freshly read one.
 */
export function openCodeAuthContent(login?: { accessToken: string; accountId?: string | undefined }): string {
  if (login == null) return "{}";
  return JSON.stringify({
    openai: {
      type: "oauth",
      access: login.accessToken,
      refresh: "host-managed",
      expires: Number.MAX_SAFE_INTEGER,
      ...(login.accountId != null ? { accountId: login.accountId } : {}),
    },
  });
}

/** Same test as the Claude Code engine's: only a `detach()` payload names a running bridge. */
function namesLiveBridge(state: HarnessAgentResumeSessionState): boolean {
  const data = (state as { data?: { bridge?: unknown } }).data;
  return data?.bridge != null;
}

/**
 * OpenCode as an AI SDK `Agent`, driven by the official harness adapter over a
 * host-local sandbox. The bridge starts `opencode serve` and talks to it over
 * its SDK.
 *
 * - The sandbox runs in `dataDir`, not in the repository; `repoPath` reaches the
 *   runtime as `sessionWorkDir` (see `withRepoWorkDir`).
 * - Authentication is OpenCode's own. The sandbox keeps the caller's real
 *   `HOME`, so the `opencode` server inside the bridge reads the machine's
 *   `~/.local/share/opencode/auth.json` and global config and refreshes its own
 *   OAuth tokens, exactly as when a human runs it. `auth` defaults to an empty
 *   environment for the same reason the Claude Code engine never uses
 *   `'auto'`: the adapter would read a subscription token once, on the host,
 *   and forward it as a static variable that expires while a turn is parked at
 *   an approval. An explicit environment skips that read entirely.
 * - The resume model is the Claude Code engine's: `stop()` / `resumeFrom` for a
 *   finished turn, `suspend()` / `continueFrom` for one parked on the human.
 */
export async function createOpenCodeEngine(options: OpenCodeEngineOptions): Promise<OpenCodeEngine> {
  const repoPath = await resolveRepoPath(options.repoPath, "OpenCode");
  const dataDir = await ensureDirectory(resolve(options.dataDir ?? DEFAULT_OPENCODE_DATA_DIR), 0o700);

  const provider = createLocalSandboxProvider({
    cwd: dataDir,
    // `node` for the bridge, `pnpm` for its bootstrap install, then the user's
    // own PATH: OpenCode's bash tool runs commands with exactly this
    // environment, and a project's `rg`, `gh` or `python3` live there.
    pathExtensions: [dirname(process.execPath), resolvePnpmDir(), ...userPath()],
    env: {
      HOME: homedir(),
      USER: userInfo().username,
      ...(process.env.SHELL != null ? { SHELL: process.env.SHELL } : {}),
      ...options.env,
    },
    // The bridge binds port 0 and reports the port it actually got; so does the `opencode` server behind it.
    allowDynamicPorts: true,
    loopbackOnly: true,
  });

  const harness = createOpenCode({
    auth: options.auth ?? {},
    port: 0,
    ...(options.reasoningVariant != null ? { reasoningVariant: options.reasoningVariant } : {}),
    ...(options.openCodeConfig != null ? { openCodeConfig: options.openCodeConfig } : {}),
    ...(options.mcpServers != null ? { mcpServers: options.mcpServers } : {}),
  });

  const { sandbox, stopHandedOut, forget } = trackSandboxSessions(provider);

  const agent = new HarnessAgent({
    id: "vgent-opencode",
    harness: withRepoWorkDir(harness, repoPath),
    sandbox,
    permissionMode: options.permissionMode ?? "allow-edits",
    ...(options.model != null ? { model: options.model } : {}),
    ...(options.tools != null ? { tools: options.tools } : {}),
    ...(options.skills != null ? { skills: options.skills } : {}),
    ...(options.instructions != null ? { instructions: options.instructions } : {}),
    ...(options.activeTools != null ? { activeTools: options.activeTools as never } : {}),
  });

  let session: HarnessAgentSession;
  try {
    if (options.continueFrom != null) {
      if (options.sessionId == null) throw new Error("OpenCode engine: `continueFrom` requires the `sessionId` that produced it.");
      if (options.resumeFrom != null) throw new Error("OpenCode engine: pass either `resumeFrom` or `continueFrom`, not both.");
      session = await agent.createSession({ sessionId: options.sessionId, continueFrom: options.continueFrom });
    } else {
      session = await agent.createSession({
        ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
        ...(options.resumeFrom != null ? { resumeFrom: options.resumeFrom } : {}),
      });
      // A `stop()` payload respawns the bridge in rerun mode; detach and attach once so approvals resolve as approvals.
      if (options.sessionId != null && options.resumeFrom != null && !namesLiveBridge(options.resumeFrom)) {
        const detached = await session.detach();
        session = await agent.createSession({ sessionId: options.sessionId, resumeFrom: detached });
      }
    }
  } catch (error) {
    await stopHandedOut();
    throw error;
  }
  forget();

  return {
    agent: toTUIAgent({ agent, session }),
    harnessAgent: agent,
    session,
    stop: () => session.stop(),
    suspend: () => session.suspendTurn(),
    dispose: () => session.destroy(),
  };
}
