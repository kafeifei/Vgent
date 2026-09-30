/**
 * `@vgent/engines` — pluggable engines exposed uniformly as AI SDK `Agent`s.
 */
export {
  CLAUDE_CODE_EFFORTS,
  claudeCodeEffort,
  claudeCodeProviderEnv,
  claudeCodeThinking,
  createClaudeCodeEngine,
  defaultClaudeCodeAuth,
  DEFAULT_CLAUDE_CODE_DATA_DIR,
  type ClaudeCodeEffort,
  type ClaudeCodeEngine,
  type ClaudeCodeEngineOptions,
} from "./claude-code.js";
export {
  codexProviderEnv,
  createCodexEngine,
  DEFAULT_CODEX_DATA_DIR,
  prepareCodexHome,
  type CodexAuthEnvironment,
  type CodexEngine,
  type CodexEngineOptions,
} from "./codex.js";
export {
  createOpenCodeEngine,
  DEFAULT_OPENCODE_DATA_DIR,
  openCodeAuthContent,
  type OpenCodeEngine,
  type OpenCodeEngineOptions,
} from "./opencode.js";
export { harnessBootstrapRecipe } from "./bootstrap.js";
export { toTUIAgent, type TUIAgent } from "./to-tui-agent.js";
/**
 * Opaque harness payloads; callers persist them between turns.
 * `HarnessAgentResumeSessionState` names a *finished* turn's session,
 * `HarnessAgentContinueTurnState` an unfinished one still held by a live bridge.
 */
export type { HarnessAgentContinueTurnState, HarnessAgentPermissionMode, HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
