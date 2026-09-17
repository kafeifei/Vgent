import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  HarnessAgent,
  type HarnessAgentPermissionMode,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
  type HarnessAgentSkill,
} from "@ai-sdk/harness/agent";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { ensureDirectory, resolvePnpmDir, resolveRepoPath, withRepoWorkDir } from "./shared.js";
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
  dispose(): Promise<void>;
}

export const DEFAULT_CLAUDE_CODE_DATA_DIR = join(homedir(), ".vgent", "harness", "claude-code");

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
 * - The sandbox keeps the caller's real `HOME`. `auth: 'auto'` reuses the
 *   machine's existing Claude Code login (`~/.claude`, macOS keychain), and the
 *   `claude` CLI reads its settings from the same place.
 * - The sandbox has no request-transformation proxy, so the adapter forwards the
 *   real credential into the bridge environment and warns about it. Nothing in
 *   this module logs the environment it builds.
 * - The harness session owns its own conversation history. To keep it across
 *   processes, end a turn with `stop()` and feed the state it returns back in
 *   as `resumeFrom` together with the same `sessionId`.
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

  // Neither `HarnessAgent` nor `createLocalSandboxProvider` exposes a disposal
  // API — the only thing a failed `createSession()` can leak is a sandbox
  // session (a real host process group) the harness did not get far enough to
  // stop itself. Track what the provider hands out so the catch below can.
  const handedOut = new Set<Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>>>();
  const sandbox: HarnessV1SandboxProvider = {
    ...provider,
    createSession: async (createOptions) => {
      const created = await provider.createSession(createOptions);
      handedOut.add(created);
      return created;
    },
    ...(provider.resumeSession != null
      ? {
          resumeSession: async (resumeOptions: Parameters<NonNullable<HarnessV1SandboxProvider["resumeSession"]>>[0]) => {
            const resumed = await provider.resumeSession!(resumeOptions);
            handedOut.add(resumed);
            return resumed;
          },
        }
      : {}),
  };

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
    session = await agent.createSession({
      ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
      ...(options.resumeFrom != null ? { resumeFrom: options.resumeFrom } : {}),
    });
    if (options.sessionId != null && options.resumeFrom != null && !namesLiveBridge(options.resumeFrom)) {
      const detached = await session.detach();
      session = await agent.createSession({ sessionId: options.sessionId, resumeFrom: detached });
    }
  } catch (error) {
    // `stop()` on the local sandbox is memoized, so stopping a session the
    // harness already cleaned up is a no-op rather than a double kill.
    for (const orphan of handedOut) await Promise.resolve(orphan.stop()).catch(() => {});
    handedOut.clear();
    throw error;
  }
  handedOut.clear();

  return {
    agent: toTUIAgent({ agent, session }),
    harnessAgent: agent,
    session,
    stop: () => session.stop(),
    dispose: () => session.destroy(),
  };
}
