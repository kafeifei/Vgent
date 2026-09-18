/**
 * `@vgent/server` — the Hono backend a `useChat` web client talks to.
 */
export { createApp, VGENT_SERVER_VERSION, type CreateAppOptions, type VgentApp } from "./app.js";
export { createChunkHub, type ChunkHub } from "./chunk-hub.js";
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
  type Files,
  type ListFilesOptions,
} from "./files.js";
export { pickFile, pickFolder, type ExecFileFn, type PickFolderOptions } from "./folder-picker.js";
export {
  createGit,
  type ChangeStatus,
  type ChangedFile,
  type ChangesSnapshot,
  type CreateGitOptions,
  type FileDiff,
  type Git,
} from "./git.js";
export {
  asIntegrateAction,
  changeStatsOf,
  createIntegrator,
  runCommand,
  taskTarget,
  type CreateIntegratorOptions,
  type IntegrateAction,
  type IntegrationStatus,
  type Integrator,
  type TaskMode,
  type TaskTarget,
  type ToolExec,
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
export { AUTO_TITLE_MAX_LEN, createRunManager, deriveThreadTitle, recoverInterruptedThreads, type RunManager } from "./runs.js";
export { readJsonOrQuarantine, writeFileAtomic, writeJsonAtomic } from "./store/atomic-file.js";
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
  ChangeStats,
  ConnectionInfo,
  EngineId,
  HarnessState,
  Logger,
  PermissionMode,
  Project,
  Settings,
  ThreadMessageMetadata,
  ThreadMode,
  ThreadOutcome,
  ThreadRecord,
  ThreadStatus,
  ThreadSummary,
  ThreadWorkspace,
  UsageInfo,
  WorkspaceSetup,
} from "./types.js";
/** Re-exported so the web client can type its settings form without depending on `@vgent/engine` directly. */
export type { McpHttpServerConfig, McpServerConfig, McpStdioServerConfig } from "@vgent/engine";
