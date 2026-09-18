/**
 * `@vgent/engine` — Vgent's own coding engine.
 *
 * A plain AI SDK `ToolLoopAgent`: the SDK owns the loop, tool approvals and
 * context pruning; this package supplies the tools (`@vgent/tools`), the model
 * (`@vgent/providers`), the permission policy and the system prompt.
 */
export { createVgentEngine, resolveModel, CODEX_SUBSCRIPTION_PREFIX } from "./engine.js";
export type { VgentEngine, VgentEngineOptions, VgentEngineEvent } from "./engine.js";
export {
  createToolApproval,
  decideApproval,
  isReadOnlyCommand,
  splitShellSegments,
  type ApprovalDecision,
  type PermissionMode,
} from "./permissions.js";
export { buildInstructions, type BuildInstructionsOptions, type VgentContext } from "./instructions.js";
export {
  askUserQuestionsTool,
  askUserQuestionsInputSchema,
  askUserQuestionsOutputSchema,
  type AskUserQuestionsInput,
  type AskUserQuestionsOutput,
} from "./ask-user-questions.js";
export { appendSession, loadSession, type SessionRecord, type LoadSessionOptions } from "./session-store.js";
export { updatePlanTool, updatePlanInputSchema, type UpdatePlanInput } from "./update-plan.js";
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
