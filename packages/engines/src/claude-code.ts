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
import { createClaudeCode, type ClaudeCodeThinkingConfig } from "@ai-sdk/harness-claude-code";
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
  /**
   * Extended thinking, passed to the adapter as-is. Defaults to the harness's
   * own `{ type: 'adaptive', display: 'summarized' }`. Build one from a thread's
   * 「思考等级」with {@link claudeCodeThinking}.
   */
  thinking?: ClaudeCodeThinkingConfig;
  /**
   * How hard Claude works while adaptive thinking is on
   * (`ClaudeCodeHarnessSettings.effort`). Build one from a thread's level with
   * {@link claudeCodeEffort}. Unset leaves the Agent SDK's own default.
   */
  effort?: ClaudeCodeEffort;
  /** AI SDK tools executed in this host process when Claude calls them. */
  tools?: ToolSet;
  /**
   * The only tools the runtime may call this session, by their harness names
   * (`read`, `grep`, `glob`, `TodoWrite`, …). Everything else is excluded —
   * the adapter passes the complement to the CLI as `disallowedTools` *and*
   * refuses it at the bridge's permission layer, so this is a real restriction
   * rather than a request. Unset leaves the whole built-in set available.
   */
  activeTools?: readonly string[];
  /**
   * Extra instructions for the runtime, appended to its native system prompt.
   * This is the harness's own mechanism (`HarnessAgentSettings.instructions`).
   */
  instructions?: string;
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
  /**
   * Extra environment for the `claude` CLI, on top of the engine's own. What a
   * custom endpoint needs beyond its credential — see {@link claudeCodeProviderEnv}.
   */
  env?: Readonly<Record<string, string>>;
}

/**
 * Everything the runtime needs to run one model of an Anthropic-compatible
 * provider: the credential for the adapter (`auth`) and the CLI environment
 * that keeps *every* request on that model (`env`).
 *
 * The second half matters as much as the first. Besides the model a session
 * names, the CLI calls a "small fast model" for titles and summaries, maps the
 * `haiku` / `sonnet` / `opus` aliases to Anthropic ids, and gives native
 * subagents a model of their own — all of which a third-party endpoint has never
 * heard of. Pinning each of them to the chosen model is what vendors' own
 * Claude Code guides do.
 *
 * Anthropic's own API is the exception on both counts: it takes the key as
 * `x-api-key` (`ANTHROPIC_API_KEY`) and refuses it as a Bearer token, and it
 * knows every alias the CLI asks for — pinning them all to the chosen model
 * would only send the cheap background calls to the expensive model.
 */
export function claudeCodeProviderEnv(options: { baseURL: string; apiKey?: string; model: string }): {
  auth: Readonly<Record<string, string>>;
  env: Readonly<Record<string, string>>;
} {
  const hasKey = options.apiKey != null && options.apiKey !== "";
  if (isAnthropicOwnApi(options.baseURL)) {
    return { auth: hasKey ? { ANTHROPIC_API_KEY: options.apiKey! } : {}, env: {} };
  }
  return {
    auth: {
      ANTHROPIC_BASE_URL: options.baseURL,
      ...(hasKey ? { ANTHROPIC_AUTH_TOKEN: options.apiKey! } : {}),
    },
    env: {
      ANTHROPIC_MODEL: options.model,
      ANTHROPIC_SMALL_FAST_MODEL: options.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: options.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: options.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: options.model,
      CLAUDE_CODE_SUBAGENT_MODEL: options.model,
    },
  };
}

function isAnthropicOwnApi(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
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
 * A thread's「思考等级」as the Claude Code harness spells it. The three levels
 * the model catalog offers for this engine are the three `thinking.type` values
 * (`ClaudeCodeHarnessSettings.thinking`); anything else — including no choice at
 * all — falls back to the harness's own default, adaptive thinking.
 *
 * `display: 'summarized'` on both thinking modes is what makes the reasoning
 * reach the client as text; `'omitted'` would keep it internal.
 */
export function claudeCodeThinking(level: string | undefined): ClaudeCodeThinkingConfig {
  if (level === "disabled") return { type: "disabled" };
  if (level === "enabled") return { type: "enabled", display: "summarized" };
  return { type: "adaptive", display: "summarized" };
}

/** The five effort levels the harness takes, weakest first. */
export const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

/**
 * A thread's level as the harness's `effort`. Anything that is not one of the
 * five — no choice at all, or a `disabled` / `adaptive` / `enabled` stored by a
 * build that still offered the thinking types here — is `fallback`.
 */
export function claudeCodeEffort(level: string | undefined, fallback: ClaudeCodeEffort = "high"): ClaudeCodeEffort {
  return (CLAUDE_CODE_EFFORTS as readonly string[]).includes(level ?? "") ? (level as ClaudeCodeEffort) : fallback;
}

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
    ...(options.thinking != null ? { thinking: options.thinking } : {}),
    ...(options.effort != null ? { effort: options.effort } : {}),
    env: {
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...options.env,
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
    ...(options.instructions != null ? { instructions: options.instructions } : {}),
    // `activeTools` is typed against the adapter's own tool map; the caller
    // names the tools as plain strings and the harness validates them.
    ...(options.activeTools != null ? { activeTools: options.activeTools as never } : {}),
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
