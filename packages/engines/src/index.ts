/**
 * `@vgent/engines` — pluggable engines exposed uniformly as AI SDK `Agent`s.
 */
export {
  createClaudeCodeEngine,
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
/** Opaque harness resume payload; callers persist it between turns. */
export type { HarnessAgentPermissionMode, HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
