/**
 * `@vgent/engines` — pluggable engines exposed uniformly as AI SDK `Agent`s.
 */
export {
  claudeCodeThinking,
  createClaudeCodeEngine,
  defaultClaudeCodeAuth,
  DEFAULT_CLAUDE_CODE_DATA_DIR,
  type ClaudeCodeEngine,
  type ClaudeCodeEngineOptions,
} from "./claude-code.js";
export {
  createCodexEngine,
  DEFAULT_CODEX_DATA_DIR,
  type CodexEngine,
  type CodexEngineOptions,
} from "./codex.js";
export { toTUIAgent, type TUIAgent } from "./to-tui-agent.js";
/**
 * Opaque harness payloads; callers persist them between turns.
 * `HarnessAgentResumeSessionState` names a *finished* turn's session,
 * `HarnessAgentContinueTurnState` an unfinished one still held by a live bridge.
 */
export type { HarnessAgentContinueTurnState, HarnessAgentPermissionMode, HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
