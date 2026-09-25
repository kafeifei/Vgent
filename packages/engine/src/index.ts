/**
 * `@vgent/engine` — Vgent's own coding engine.
 *
 * A plain AI SDK `ToolLoopAgent`: the SDK owns the loop, tool approvals and
 * context pruning; this package supplies the tools (`@vgent/tools`), the model
 * (`@vgent/providers`), the permission policy and the system prompt.
 */
export { createVgentEngine, reasoningProviderOptions, resolveModel, usesOpenAIReasoning, CODEX_SUBSCRIPTION_PREFIX } from "./engine.js";
export type { VgentEngine, VgentEngineOptions, VgentEngineEvent, VgentReasoningOptions } from "./engine.js";
export { createToolApproval, decideApproval, type ApprovalDecision, type PermissionMode } from "./permissions.js";
// Also published as the `@vgent/engine/allowlist` subpath: the browser answers
// the same 「一直允许」 question for the harness engines and must not pull the
// rest of this package into its bundle.
export {
  BASH_TOOL,
  bashEntry,
  bashEntryCommand,
  commandsToAllow,
  isAllowlisted,
  isReadOnlyCommand,
  isVoidedBashEntry,
  segmentCommand,
  splitShellSegments,
  unlistedCommands,
} from "./allowlist.js";
export { buildInstructions, planModeInstructions, type BuildInstructionsOptions, type VgentContext } from "./instructions.js";
export {
  askUserQuestionsTool,
  askUserQuestionsInputSchema,
  askUserQuestionsOutputSchema,
  type AskUserQuestionsInput,
  type AskUserQuestionsOutput,
} from "./ask-user-questions.js";
export { appendSession, loadSession, type SessionRecord, type LoadSessionOptions } from "./session-store.js";
export { updatePlanTool, updatePlanInputSchema, type UpdatePlanInput } from "./update-plan.js";
export { createMemoryTool, memoryInputSchema, type MemoryInput } from "./memory.js";
export { createSubagentTools, summarizeSubagentMessage, type CreateSubagentToolsOptions } from "./subagents.js";
export {
  connectMcpServers,
  hasDeferredTools,
  parseMcpServers,
  prepareMcpTools,
  type McpConnection,
  type McpHttpServerConfig,
  type McpLogger,
  type McpServerConfig,
  type McpStdioServerConfig,
} from "./mcp.js";
export { loadSkillsIndex, parseSkillFrontmatter, type SkillSummary } from "./skills.js";
export {
  agentInstructionsSection,
  loadAgentInstructions,
  type AgentInstructionsFile,
  type AgentInstructionsOptions,
} from "./agent-instructions.js";

export { type TaskState } from "./update-plan.js";
export { type EngineOutcome } from "./engine.js";
export { fitContext, estimateTokens, SUMMARY_INSTRUCTIONS } from "./context.js";

export { classifyFailure, type FailureClass } from "./failures.js";
