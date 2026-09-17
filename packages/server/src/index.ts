/**
 * `@vgent/server` — the Hono backend a `useChat` web client talks to.
 */
export { createApp, VGENT_SERVER_VERSION, type CreateAppOptions, type VgentApp } from "./app.js";
export { createChunkHub, type ChunkHub } from "./chunk-hub.js";
export {
  BadRequestError,
  ConflictError,
  EngineUnavailableError,
  GitError,
  GitUnavailableError,
  NotAGitRepoError,
  NotFoundError,
  NotImplementedError,
  UnauthorizedError,
  VgentServerError,
} from "./errors.js";
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
  createEngineRegistry,
  statelessEngines,
  type EngineContext,
  type EngineFactory,
  type EngineRegistry,
  type EngineRunner,
} from "./engines/registry.js";
export { createClaudeCodeEngineFactory } from "./engines/claude-code.js";
export { createCodexEngineFactory } from "./engines/codex.js";
export { createVgentEngineFactory, DEFAULT_VGENT_MODEL, type VgentEngineFactoryOptions } from "./engines/vgent.js";
export { AUTO_TITLE_MAX_LEN, createRunManager, deriveThreadTitle, recoverInterruptedThreads, type RunManager } from "./runs.js";
export { readJsonOrQuarantine, writeJsonAtomic } from "./store/atomic-file.js";
export { createProjectStore, type ProjectStore } from "./store/projects.js";
export { createSettingsStore, DEFAULT_SETTINGS, type SettingsStore } from "./store/settings.js";
export { createThreadStore, DEFAULT_THREAD_TITLE, summarize, type CreateThreadInput, type ThreadPatch, type ThreadStore } from "./store/threads.js";
export { DEFAULT_DATA_DIR, resolveDataDir } from "./paths.js";
export type {
  ConnectionInfo,
  EngineId,
  HarnessState,
  Logger,
  PermissionMode,
  Project,
  Settings,
  ThreadRecord,
  ThreadStatus,
  ThreadSummary,
} from "./types.js";
