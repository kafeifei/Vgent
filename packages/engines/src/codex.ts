import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessAgent, type HarnessAgentPermissionMode, type HarnessAgentSession, type HarnessAgentSkill } from "@ai-sdk/harness/agent";
import { createCodex } from "@ai-sdk/harness-codex";
import { createLocalSandboxProvider } from "@vgent/sandbox-local";
import type { ToolSet } from "ai";
import { ensureDirectory, resolvePnpmDir, resolveRepoPath, withRepoWorkDir } from "./shared.js";
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
}

export interface CodexEngine {
  /** AI SDK `Agent` with the engine's single harness session bound in. */
  agent: TUIAgent;
  session: HarnessAgentSession;
  dispose(): Promise<void>;
}

export const DEFAULT_CODEX_DATA_DIR = join(homedir(), ".vgent", "harness", "codex");

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
 *   entirely; the credential is still supplied via env, so auth is unaffected.
 * - The Codex harness has no built-in tool approval (`supportsBuiltinToolApprovals:
 *   false`) and no built-in tool filtering. `HarnessAgent`'s constructor already
 *   rejects any `permissionMode` other than `'allow-all'` for such a harness
 *   with `HarnessCapabilityUnsupportedError`, so this engine does not need to
 *   duplicate that check — it only changes the default to `'allow-all'` up
 *   front, since that is the sole supported value.
 * - The sandbox has no request-transformation proxy, so the adapter forwards the
 *   real credential into the bridge environment and warns about it. Nothing in
 *   this module logs the environment it builds.
 */
export async function createCodexEngine(options: CodexEngineOptions): Promise<CodexEngine> {
  const repoPath = await resolveRepoPath(options.repoPath, "Codex");
  const dataDir = await ensureDirectory(resolve(options.dataDir ?? DEFAULT_CODEX_DATA_DIR), 0o700);
  // Isolated from the real `~/.codex`; see the module doc comment above.
  const codexHomeDir = await ensureDirectory(join(dataDir, "codex-home"), 0o700);

  const sandbox = createLocalSandboxProvider({
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

  const harness = createCodex({
    auth: "auto",
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

  const session = await agent.createSession();

  return {
    agent: toTUIAgent({ agent, session }),
    session,
    dispose: () => session.destroy(),
  };
}
