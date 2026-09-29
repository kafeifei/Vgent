import type { UIMessage } from "ai";
import type { ThreadTransition } from "@vgent/server";

/**
 * The server's own shapes, re-exported so the client can never drift from them.
 *
 * `@vgent/server` is a type-only dependency here: its `exports` map points at
 * `dist/index.d.ts`, and every value import would drag Hono and the harness
 * into the bundle. Nothing below may be imported without `import type`.
 */
export type {
  ApplyConflict,
  ApplyReport,
  ChangedFile,
  ChangeStats,
  ChangeStatus,
  CuaStatus,
  CuaTestResult,
  ChangesResponse,
  ChangesSnapshot,
  CheckpointPreview,
  CheckpointRestore,
  EngineCapabilities,
  EngineDescriptor,
  EngineId,
  FileContent,
  FileDiff,
  FileEntry,
  FileListing,
  ResolvedFile,
  IntegrateAction,
  IntegrationStatus,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  MessageCheckpoint,
  ModelCatalog,
  ModelEntry,
  ModelPick,
  PlanDocument,
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
  ThreadTransition,
  ThreadWorkspace,
  UiDensity,
  UiTheme,
  UndoApplyResult,
  CatalogProvider,
  CatalogProviderSummary,
  ModelCost,
  ProviderAgent,
  ProviderAgentConfig,
  ProviderModel,
  ProviderProtocol,
  RedactedProviderConfig,
  ClaudeLoginAttempt,
  SubscriptionAccount,
  SubscriptionId,
  SubscriptionModel,
  UsageInfo,
  WorkspaceSetup,
  HarnessEngineId,
  HarnessRuntimeStatus,
} from "@vgent/server";

/**
 * `POST /api/threads/:id/integrate`: the task as it now stands, plus what this
 * one action did — 带回主目录 has a file list to show, 撤销带回 says what it left
 * alone, and a push to a non-GitHub remote has a sentence to read.
 */
export type IntegrateResponse = import("@vgent/server").ThreadRecord & {
  apply?: import("@vgent/server").ApplyReport;
  undo?: import("@vgent/server").UndoApplyResult;
  note?: string;
};

/** `GET /api/threads/:id/workspace/setup-log`. `none` = the project has no setup config. */
export type SetupLog = {
  status: "none" | "running" | "ok" | "failed";
  exitCode?: number;
  log: string;
};

/** What a new task asks for: the project's working tree, or its own worktree. */
export type WorkspaceMode = "project" | "worktree";

/**
 * 改动的范围: the whole task against its 任务基线, or just the last turn — the
 * diff between the snapshots taken before and after it, which is read-only.
 */
export type ChangesScope = "all" | "last-turn";

/** Payload of the `state` event on `GET /api/state`. */
export type StateEvent = {
  projects: import("@vgent/server").Project[];
  threads: import("@vgent/server").ThreadSummary[];
  settings: import("@vgent/server").Settings;
};

/** Input shape of the `askUserQuestions` tool. */
export type AskUserQuestionsInput = {
  allowPartialAnswers: boolean;
  questions: Array<{
    id: string;
    question: string;
    header?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    allowMultiple?: boolean;
    allowFreeForm?: boolean;
  }>;
};

/** One answer in an `askUserQuestions` submission. */
export type QuestionAnswer = { optionIds: string[]; freeform?: string };

/** Output shape of the `askUserQuestions` tool. */
export type AskUserQuestionsOutput =
  | { action: "answered" | "partially-answered"; answers: Record<string, QuestionAnswer> }
  | { action: "declined" }
  | { action: "cancelled" };

/** A thread whose turn is still alive on the server. */
export const LIVE_STATUSES = ["running", "awaiting-approval", "awaiting-input"] as const;

/** Why 收口 and 归档 are off while a turn lives — the server's own 409 says the same. */
export const LIVE_REASON = "任务还在进行中（等待审批或回答），先处理或停止";

/** 归档中 / 恢复中: what a task says while its worktree is still being moved. */
export const TRANSITION_LABELS: Record<ThreadTransition, string> = {
  archiving: "归档中",
  unarchiving: "恢复中",
};

export type UIMessagePart = UIMessage["parts"][number];

export type { RemoteAccessState, RemoteDevice } from "@vgent/server";

export type { AccountId, AccountSummary, AccountSnapshot, AccountUsage, UsageWindow } from "@vgent/server";
