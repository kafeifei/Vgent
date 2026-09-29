import { randomUUID } from "node:crypto";
import { rename, rm, stat, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  HarnessAgent,
  type HarnessAgentPermissionMode,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
  type HarnessAgentSkill,
} from "@ai-sdk/harness/agent";
import { createCodex } from "@ai-sdk/harness-codex";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { ensureDirectory, resolvePnpmDir, resolveRepoPath, trackSandboxSessions, withRepoWorkDir } from "./shared.js";
import { toTUIAgent, type TUIAgent } from "./to-tui-agent.js";

export interface CodexEngineOptions {
  /** Repository the agent works in. Becomes the harness session working directory. */
  repoPath: string;
  /**
   * Directory the sandbox runs in, holding the bridge bootstrap and run data.
   * Defaults to `~/.vgent/harness/codex`. Never the user's repository: the
   * adapter installs `.harness-bootstrap/` and `.agent-runs/` under it.
   */
  dataDir?: string;
  /**
   * Built-in tool permission mode. Defaults to `allow-all`, the only mode the
   * Codex harness supports: it has no built-in tool approval, so `HarnessAgent`
   * throws `HarnessCapabilityUnsupportedError` at construction time for any
   * other value, instead of silently running some tools unapproved.
   */
  permissionMode?: HarnessAgentPermissionMode;
  /** Harness-specific model identifier. Defaults to the runtime's own default. */
  model?: string;
  /** AI SDK tools executed in this host process when Codex calls them. */
  tools?: ToolSet;
  /** Instruction bundles surfaced to the runtime. Codex has no skills directory of its own, so the adapter inlines these into the prompt every turn. */
  skills?: readonly HarnessAgentSkill[];
  /** Reasoning effort for reasoning-capable models. Defaults to the CLI's own default. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Allow the underlying runtime to use live web search. */
  webSearch?: boolean;
  /**
   * Where Codex gets its models. Unset, it is the machine's ChatGPT / Codex
   * login (`auth: 'auto'`). Set — see `codexProviderEnv` — Codex runs on that
   * endpoint and key instead and the login is not read at all.
   */
  auth?: CodexAuthEnvironment;
  /**
   * Extra Codex config, passed through as is (snake_case keys). Used for what
   * Codex cannot know about a provider's model — `model_context_window` — since
   * it only carries metadata for OpenAI's own.
   */
  codexConfig?: Record<string, unknown>;
  /**
   * Stable identifier for the underlying harness session. Required together
   * with `resumeFrom` to reattach a session created by an earlier process.
   */
  sessionId?: string;
  /**
   * Resume payload returned by a previous `stop()`. Must be paired with the
   * `sessionId` that produced it; `HarnessAgent` validates it against the
   * adapter before handing it to the runtime.
   */
  resumeFrom?: HarnessAgentResumeSessionState;
}

export interface CodexEngine {
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
   * state goes back in as `resumeFrom` on the next `createCodexEngine` call
   * with the same `sessionId`.
   */
  stop(): Promise<HarnessAgentResumeSessionState>;
  dispose(): Promise<void>;
}

export const DEFAULT_CODEX_DATA_DIR = join(homedir(), ".vgent", "harness", "codex");

/**
 * The private `CODEX_HOME` under `dataDir` (see {@link createCodexEngine}),
 * with the user's own global `AGENTS.md` linked in: isolating the config must
 * not also drop the rules Codex follows everywhere else. A symlink, so edits
 * apply on the next turn; replaced by rename, so concurrent engines never see
 * it missing.
 */
export async function prepareCodexHome(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const home = await ensureDirectory(join(dataDir, "codex-home"), 0o700);
  const own = join(resolve(env.CODEX_HOME ?? join(homedir(), ".codex")), "AGENTS.md");
  const link = join(home, "AGENTS.md");
  if (own === link) return home;
  if (await stat(own).then(() => false, () => true)) {
    await rm(link, { force: true });
    return home;
  }
  const staged = `${link}.${randomUUID()}`;
  await symlink(own, staged);
  await rename(staged, link);
  return home;
}

/** The authentication environment the Codex adapter reads (`pickOpenAI`): a key and the endpoint it is for. */
export type CodexAuthEnvironment = Readonly<Record<string, string>> & {
  readonly OPENAI_BASE_URL: string;
  readonly OPENAI_API_KEY: string;
};

/**
 * Points Codex at a provider from the settings page. Given an explicit
 * environment, the adapter skips the subscription login, and its bridge turns
 * `OPENAI_BASE_URL` into a Codex `model_providers` entry with
 * `wire_api = "responses"` — so the endpoint has to speak OpenAI's Responses
 * API (`POST <baseURL>/responses`); chat-completions alone is not enough.
 *
 * A keyless endpoint (a server on this machine) still gets a placeholder: the
 * bridge only builds that provider entry when there is a key to name.
 */
export function codexProviderEnv(input: { baseURL: string; apiKey?: string }): CodexAuthEnvironment {
  return { OPENAI_BASE_URL: input.baseURL.replace(/\/+$/, ""), OPENAI_API_KEY: input.apiKey != null && input.apiKey !== "" ? input.apiKey : "unused" };
}

/**
 * Codex as an AI SDK `Agent`, driven by the official harness adapter over a
 * host-local sandbox.
 *
 * - The sandbox runs in `dataDir`, not in the repository: the adapter writes its
 *   bridge bootstrap and per-session run data under the sandbox's default
 *   working directory, which must stay Vgent-owned.
 * - `repoPath` reaches the runtime as `sessionWorkDir`. `HarnessAgent` always
 *   composes that path underneath the sandbox directory, so the adapter is
 *   wrapped to override it.
 * - `auth: 'auto'` reuses the machine's existing Codex login: the adapter
 *   reads `~/.codex/auth.json` (respecting `CODEX_HOME`) from this *host*
 *   process, refreshes the token if needed, and turns it into a bearer
 *   credential (`CODEX_API_KEY` + `OPENAI_BASE_URL`) that it forwards into the
 *   sandboxed process's environment directly. None of that depends on the
 *   sandboxed `codex` CLI's own `HOME`/`CODEX_HOME`.
 * - The sandbox keeps the caller's real `HOME` (for parity with the Claude Code
 *   engine), but `CODEX_HOME` is pointed at a private directory under `dataDir`
 *   instead of the real `~/.codex`. Verified against a real login on this
 *   machine: pointing the sandboxed CLI at the real `~/.codex` makes it load
 *   the real, much more elaborate `config.toml` from this machine's full Codex
 *   app install, whose `features` table this adapter's pinned
 *   `@openai/codex-sdk` version cannot parse (`invalid type: map, expected a
 *   boolean`), crashing every turn. An isolated `CODEX_HOME` sidesteps that
 *   entirely; the credential is still supplied via env, so auth is unaffected,
 *   and the user's global `AGENTS.md` is linked in ({@link prepareCodexHome}).
 * - The Codex harness has no built-in tool approval (`supportsBuiltinToolApprovals:
 *   false`) and no built-in tool filtering. `HarnessAgent`'s constructor already
 *   rejects any `permissionMode` other than `'allow-all'` for such a harness
 *   with `HarnessCapabilityUnsupportedError`, so this engine does not need to
 *   duplicate that check — it only changes the default to `'allow-all'` up
 *   front, since that is the sole supported value.
 * - The sandbox has no request-transformation proxy, so the adapter forwards the
 *   real credential into the bridge environment and warns about it. Nothing in
 *   this module logs the environment it builds.
 * - The harness session owns its own conversation history. To keep it across
 *   processes, end a turn with `stop()` and feed the state it returns back in
 *   as `resumeFrom` together with the same `sessionId`.
 */
export async function createCodexEngine(options: CodexEngineOptions): Promise<CodexEngine> {
  const repoPath = await resolveRepoPath(options.repoPath, "Codex");
  const dataDir = await ensureDirectory(resolve(options.dataDir ?? DEFAULT_CODEX_DATA_DIR), 0o700);
  // Isolated from the real `~/.codex`; see the module doc comment above.
  const codexHomeDir = await prepareCodexHome(dataDir);

  const provider = createLocalSandboxProvider({
    cwd: dataDir,
    // `node` for the bridge, `pnpm` for its bootstrap install.
    pathExtensions: [dirname(process.execPath), resolvePnpmDir()],
    env: {
      HOME: homedir(),
      CODEX_HOME: codexHomeDir,
    },
    // The bridge binds port 0 and reports the port it actually got.
    allowDynamicPorts: true,
    loopbackOnly: true,
  });

  // Track what the provider hands out so the catch below can stop a session a
  // failed `createSession()` would otherwise leak.
  const { sandbox, stopHandedOut, forget } = trackSandboxSessions(provider);

  const harness = createCodex({
    auth: options.auth ?? "auto",
    ...(options.codexConfig != null ? { codexConfig: options.codexConfig } : {}),
    port: 0,
    ...(options.reasoningEffort != null ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.webSearch != null ? { webSearch: options.webSearch } : {}),
  });

  const agent = new HarnessAgent({
    id: "vgent-codex",
    harness: withRepoWorkDir(harness, repoPath),
    sandbox,
    permissionMode: options.permissionMode ?? "allow-all",
    ...(options.model != null ? { model: options.model } : {}),
    ...(options.tools != null ? { tools: options.tools } : {}),
    ...(options.skills != null ? { skills: options.skills } : {}),
  });

  // No detach→attach dance here, unlike the Claude Code engine. That dance
  // exists because a resume payload with no live bridge respawns the runtime in
  // *rerun* mode, whose `continueTurn` restarts the conversation with a
  // synthetic `"Continue."` prompt instead of resolving a pending approval. The
  // Codex adapter takes the same two branches, but it reports
  // `supportsBuiltinToolApprovals: false` and this engine passes no host
  // `tools`, so a Codex turn can never pause — `continueTurn` is never reached,
  // and the rerun flag has nothing to spoil. A plain
  // `createSession({ sessionId, resumeFrom })` after a previous `stop()` is
  // enough: the adapter re-seeds the Codex thread on the next prompt
  // (`seedResumeThreadOnFirstPrompt`).
  let session: HarnessAgentSession;
  try {
    session = await agent.createSession({
      ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
      ...(options.resumeFrom != null ? { resumeFrom: options.resumeFrom } : {}),
    });
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
    dispose: () => session.destroy(),
  };
}
