/**
 * `@vgent/server` — the Hono backend a `useChat` web client talks to.
 */
export { createApp, VGENT_SERVER_VERSION, type CreateAppOptions, type VgentApp } from "./app.js";
export { createChunkHub, type ChunkHub } from "./chunk-hub.js";
export {
  partitionUndo,
  planThreeWayApply,
  runApplyPlan,
  type ApplyConflict,
  type ApplyConflictMode,
  type ApplyPlan,
  type ApplyReport,
  type ThreeWayApplyOptions,
  type UndoApplyResult,
} from "./apply.js";
export {
  applyUndoScope,
  changedPaths,
  CHECKPOINT_RETENTION,
  checkpointRefPrefix,
  createAfterCheckpoint,
  createCheckpoint,
  deleteCheckpoints,
  listCheckpointCommits,
  restoreCheckpoint,
  snapshotTree,
  type Checkpoint,
  type RestoreResult,
} from "./checkpoints.js";
export {
  asRestoreTarget,
  lastTurnPair,
  planRestore,
  restoreNote,
  turnSnapshots,
  type RestorePlan,
  type RestoreTarget,
  type TurnSnapshots,
} from "./restore.js";
export {
  BadRequestError,
  ConflictError,
  EngineUnavailableError,
  ExternalToolError,
  GitError,
  GitUnavailableError,
  NotAGitRepoError,
  NotFoundError,
  NotImplementedError,
  UnauthorizedError,
  VgentServerError,
} from "./errors.js";
export {
  createFiles,
  type CreateFilesOptions,
  type FileContent,
  type FileEntry,
  type FileListing,
  type ResolvedFile,
  type Files,
  type ListFilesOptions,
} from "./files.js";
export { pickFile, pickFolder, type ExecFileFn, type PickFolderOptions } from "./folder-picker.js";
export {
  createGit,
  type ChangeStatus,
  type ChangedFile,
  type ChangesResponse,
  type ChangesSnapshot,
  type CreateGitOptions,
  type DiffBase,
  type FileDiff,
  type Git,
} from "./git.js";
export { runCommand, type ExecOutcome, type ToolExec } from "./exec.js";
export {
  asIntegrateAction,
  changeStatsOf,
  createIntegrator,
  githubRepoFromRemote,
  taskTarget,
  type CreateIntegratorOptions,
  type IntegrateAction,
  type IntegrateInput,
  type IntegrateResult,
  type IntegrationStatus,
  type Integrator,
  type PrAvailability,
  type TaskMode,
  type TaskTarget,
} from "./integrate.js";
export {
  createEngineRegistry,
  engineDescriptors,
  engineIds,
  statelessEngines,
  type EngineContext,
  type EngineFactory,
  type EngineFactoryOverride,
  type EngineRegistry,
  type EngineRunner,
} from "./engines/registry.js";
export { effectivePermission, type EngineCapabilities, type EngineDescriptor } from "./engines/capabilities.js";
export { createClaudeCodeEngineFactory } from "./engines/claude-code.js";
export { createCodexEngineFactory } from "./engines/codex.js";
export { createVgentEngineFactory, DEFAULT_VGENT_MODEL, type VgentEngineFactoryOptions } from "./engines/vgent.js";
export {
  createModelCatalog,
  type CodexCatalogModel,
  type GatewayModelSource,
  type ModelCatalog,
  type ModelCatalogOptions,
  type ModelCatalogService,
  type ModelEntry,
} from "./models.js";
export {
  createSubscriptionService,
  parseClaudeLoginStatus,
  probeClaudeLogin,
  SUBSCRIPTION_IDS,
  type ClaudeLoginStatus,
  type SubscriptionAccount,
  type SubscriptionId,
  type SubscriptionModel,
  type SubscriptionService,
} from "./subscriptions.js";
export { createQueueStore, QUEUE_ITEM_MAX_BYTES, QUEUE_MAX_ITEMS, readQueueText, type QueueStore } from "./queue.js";
export { AUTO_TITLE_MAX_LEN, createRunManager, deriveThreadTitle, recoverInterruptedThreads, type RunManager } from "./runs.js";
export { readJsonOrQuarantine, writeFileAtomic, writeJsonAtomic } from "./store/atomic-file.js";
export {
  createDraftStore,
  isDraftKey,
  MAX_DRAFT_ATTACHMENT_BYTES,
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFT_BYTES,
  NEW_TASK_DRAFT,
  type Draft,
  type DraftAttachment,
  type DraftAttachmentInput,
  type DraftStore,
} from "./store/drafts.js";
export { createPlanStore, MAX_PLAN_BYTES, type PlanDocument, type PlanStore } from "./store/plans.js";
export { createProjectStore, type ProjectStore } from "./store/projects.js";
export { createSettingsStore, DEFAULT_SETTINGS, migrateSettings, type SettingsPatch, type SettingsStore } from "./store/settings.js";
export { createThreadStore, DEFAULT_THREAD_TITLE, summarize, type CreateThreadInput, type ThreadPatch, type ThreadStore } from "./store/threads.js";
export {
  acquireInstanceLock,
  INSTANCE_LOCK_FILE,
  INSTANCE_LOCKED_EXIT_CODE,
  InstanceLockedError,
} from "./instance-lock.js";
export { DEFAULT_DATA_DIR, resolveDataDir } from "./paths.js";
export {
  createWorktree,
  inventory,
  makeSnapshot,
  reclaimWorktree,
  removeWorktree,
  restoreWorktree,
  verifyOwnership,
  type WorkspaceOwnership,
} from "./workspace.js";
export { DEFAULT_WORKTREE_MAX_COUNT, enforceWorktreeLimit } from "./worktree-limit.js";
export { findSetupSpec, readSetupLog, runSetup, startSetup, whenSetupSettled, type SetupSpec } from "./worktree-setup.js";
export type {
  ApplyUndoRecord,
  ChangeStats,
  CheckpointPreview,
  CheckpointRestore,
  ConnectionInfo,
  EngineId,
  HarnessState,
  Logger,
  MessageCheckpoint,
  PermissionMode,
  Project,
  QueuedMessage,
  Settings,
  ThreadMessageMetadata,
  ThreadMode,
  ThreadOutcome,
  ThreadPullRequest,
  ThreadRecord,
  ThreadRestorePoint,
  ThreadStatus,
  ThreadSummary,
  ThreadWorkspace,
  UiDensity,
  UiTheme,
  UsageInfo,
  WorkspaceSetup,
} from "./types.js";
/** Re-exported so the web client can type its settings form without depending on `@vgent/engine` directly. */
export type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "@vgent/engine";
export { createProviderStore, type ProviderStore } from "./store/providers.js";
/** Re-exported so the web client types its provider settings from one place. The key never appears in any of them. */
export type {
  CatalogEndpoint,
  CatalogProvider,
  CatalogProviderSummary,
  ProviderAgent,
  ProviderAgentConfig,
  ProviderModel,
  ProviderProtocol,
  RedactedProviderConfig,
} from "@vgent/providers";
export { createCatalogStore, type CatalogSnapshot, type CatalogSource, type CatalogStore } from "./store/catalog.js";
export type { HarnessEngineId, HarnessRuntimeStatus } from "./harness-runtime.js";

export type { ClaudeLoginAttempt } from "./claude-login.js";
