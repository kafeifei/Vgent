import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HarnessV1Authentication } from "@ai-sdk/harness";
import {
  HarnessAgent,
  type HarnessAgentContinueTurnState,
  type HarnessAgentPermissionMode,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
  type HarnessAgentSkill,
} from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { ensureDirectory, resolvePnpmDir, resolveRepoPath, trackSandboxSessions, withRepoWorkDir } from "./shared.js";
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
  /**
   * Stable identifier for the underlying harness session. Required together
   * with `resumeFrom` to reattach a session created by an earlier process.
   */
  sessionId?: string;
  /**
   * Resume payload returned by a previous `stop()` (or `session.detach()`).
   * Must be paired with the `sessionId` that produced it; `HarnessAgent`
   * validates it against the adapter before handing it to the runtime.
   */
  resumeFrom?: HarnessAgentResumeSessionState;
  /**
   * Continuation payload returned by a previous `suspend()`, naming the bridge
   * that still holds the unfinished turn. Must be paired with the `sessionId`
   * that produced it, and is mutually exclusive with `resumeFrom`. The turn is
   * then driven by `harnessAgent.continueStream()`, not by `stream()`.
   */
  continueFrom?: HarnessAgentContinueTurnState;
  /**
   * What the adapter authenticates the runtime with. Defaults to
   * `defaultClaudeCodeAuth()`; see there for why it is never `'auto'`.
   */
  auth?: HarnessV1Authentication;
}

export interface ClaudeCodeEngine {
  /** AI SDK `Agent` with the engine's single harness session bound in. */
  agent: TUIAgent;
  /**
   * The raw `HarnessAgent`. Callers that drive turns themselves need it,
   * because `HarnessAgent.stream()` requires `session` on every call and the
   * `Agent`-shaped wrapper above hides it.
   */
  harnessAgent: HarnessAgent<any, any, any, any, any>;
  session: HarnessAgentSession;
  /**
   * Persist resume state, then stop the runtime and the sandbox. The returned
   * state goes back in as `resumeFrom` on the next `createClaudeCodeEngine`
   * call with the same `sessionId`.
   */
  stop(): Promise<HarnessAgentResumeSessionState>;
  /**
   * Freeze the unfinished turn and hand back the payload that reattaches to it.
   * The runtime, the bridge and the sandbox keep running — only this handle
   * dies, so the next process can pick the turn up with `continueFrom`.
   * Throws when the session has no unfinished turn.
   */
  suspend(): Promise<HarnessAgentContinueTurnState>;
  dispose(): Promise<void>;
}

export const DEFAULT_CLAUDE_CODE_DATA_DIR = join(homedir(), ".vgent", "harness", "claude-code");

/**
 * Credential variables copied out of the caller's environment, when there are
 * any. `ANTHROPIC_*` is what an API-key or custom-endpoint user sets;
 * `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` / `AI_GATEWAY_BASE_URL` are what
 * the adapter's gateway detection reads. `CLAUDE_CODE_OAUTH_TOKEN` is
 * deliberately absent — see `defaultClaudeCodeAuth`.
 */
const FORWARDED_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "VERCEL_OIDC_TOKEN",
] as const;

/**
 * The authentication environment the engine hands the adapter by default.
 *
 * `auth: 'auto'` looks right and is wrong for a long-lived session: the adapter
 * resolves the subscription OAuth token *once*, when the bridge starts, and
 * forwards it as a static `CLAUDE_CODE_OAUTH_TOKEN`. A turn parked at an
 * approval keeps that bridge alive, so a token that expires while the human is
 * away turns the continuation into a 401 the bridge treats as unrecoverable.
 *
 * Supplying an environment instead short-circuits the subscription read
 * entirely (`isHarnessAuthenticationEnvironment`), so no OAuth token is
 * forwarded at all. The sandbox keeps the caller's real `HOME`, and the
 * `claude` CLI inside the bridge then reads `~/.claude` / the macOS keychain
 * itself and refreshes its own token — exactly as it does when a human runs it.
 *
 * API-key and gateway users are unaffected: their variables are forwarded, and
 * the adapter still finds them on the object it was handed.
 */
export function defaultClaudeCodeAuth(processEnv: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED_CREDENTIAL_ENV) {
    const value = processEnv[name];
    if (value != null && value !== "") env[name] = value;
  }
  return env;
}

/**
 * True when a resume payload still names a running bridge (`data.bridge`).
 * `session.detach()` produces one; `session.stop()` does not, because it takes
 * the bridge down with it.
 *
 * The distinction decides which path the adapter takes on
 * `createSession({ resumeFrom })`, and that path is not cosmetic: a payload
 * without bridge coordinates respawns the runtime in *rerun* mode
 * (`rerunContinue: true`), and a rerun session answers **every**
 * `continueTurn` — including a tool-approval continuation — by restarting the
 * Claude Code conversation with a synthetic `"Continue."` prompt instead of
 * resolving the pending approval. The runtime then finds the previous turn's
 * `tool_use` unanswered and records it as `User rejected tool use`. Attaching
 * to the bridge clears the flag, so approvals resolve as approvals.
 */
function namesLiveBridge(state: HarnessAgentResumeSessionState): boolean {
  const data = (state as { data?: { bridge?: unknown } }).data;
  return data?.bridge != null;
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
 * - The sandbox keeps the caller's real `HOME`, and authentication defaults to
 *   `defaultClaudeCodeAuth()`: no OAuth token is forwarded, so the `claude` CLI
 *   inside the bridge reuses and refreshes the machine's own login
 *   (`~/.claude`, macOS keychain). Only an explicit API key / gateway
 *   credential is passed through, and nothing here logs the environment it
 *   builds.
 * - The harness session owns its own conversation history. To keep it across
 *   processes, end a turn with `stop()` and feed the state it returns back in
 *   as `resumeFrom` together with the same `sessionId`. An *unfinished* turn
 *   goes the other way: `suspend()` and `continueFrom`.
 */
export async function createClaudeCodeEngine(options: ClaudeCodeEngineOptions): Promise<ClaudeCodeEngine> {
  const repoPath = await resolveRepoPath(options.repoPath, "Claude Code");
  const dataDir = await ensureDirectory(resolve(options.dataDir ?? DEFAULT_CLAUDE_CODE_DATA_DIR), 0o700);

  const provider = createLocalSandboxProvider({
    cwd: dataDir,
    // `node` for the bridge, `pnpm` for its bootstrap install.
    pathExtensions: [dirname(process.execPath), resolvePnpmDir()],
    env: {
      HOME: homedir(),
      // The login the bridge is meant to reuse lives in the macOS keychain
      // under the current account name, and the CLI looks it up with
      // `security … -a $USER`. Without this the lookup runs with an empty
      // account and the runtime reports "Not logged in".
      USER: userInfo().username,
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    // The bridge binds port 0 and reports the port it actually got.
    allowDynamicPorts: true,
    loopbackOnly: true,
  });

  const harness = createClaudeCode({
    auth: options.auth ?? defaultClaudeCodeAuth(),
    port: 0,
    env: {
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  });

  // Track what the provider hands out so the catch below can stop a session a
  // failed `createSession()` would otherwise leak.
  const { sandbox, stopHandedOut, forget } = trackSandboxSessions(provider);

  const agent = new HarnessAgent({
    id: "vgent-claude-code",
    harness: withRepoWorkDir(harness, repoPath),
    sandbox,
    permissionMode: options.permissionMode ?? "allow-edits",
    ...(options.model != null ? { model: options.model } : {}),
    ...(options.tools != null ? { tools: options.tools } : {}),
    ...(options.skills != null ? { skills: options.skills } : {}),
  });

  let session: HarnessAgentSession;
  try {
    if (options.continueFrom != null) {
      // Attaching to the live bridge named by the payload. No `detach()` dance:
      // the continuation already carries bridge coordinates, which is exactly
      // what clears `rerunContinue` in the adapter.
      if (options.sessionId == null) throw new Error("Claude Code engine: `continueFrom` requires the `sessionId` that produced it.");
      if (options.resumeFrom != null) throw new Error("Claude Code engine: pass either `resumeFrom` or `continueFrom`, not both.");
      session = await agent.createSession({ sessionId: options.sessionId, continueFrom: options.continueFrom });
    } else {
      session = await agent.createSession({
        ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
        ...(options.resumeFrom != null ? { resumeFrom: options.resumeFrom } : {}),
      });
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
