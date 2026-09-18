import type { UIMessage } from "ai";

/**
 * The server's own shapes, re-exported so the client can never drift from them.
 *
 * `@vgent/server` is a type-only dependency here: its `exports` map points at
 * `dist/index.d.ts`, and every value import would drag Hono and the harness
 * into the bundle. Nothing below may be imported without `import type`.
 */
export type {
  ChangedFile,
  ChangeStats,
  ChangeStatus,
  ChangesSnapshot,
  CheckpointRestore,
  EngineCapabilities,
  EngineDescriptor,
  EngineId,
  FileContent,
  FileDiff,
  FileEntry,
  FileListing,
  IntegrateAction,
  IntegrationStatus,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  MessageCheckpoint,
  ModelCatalog,
  ModelEntry,
  PlanDocument,
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
} from "@vgent/server";

/** `GET /api/threads/:id/workspace/setup-log`. `none` = the project has no setup config. */
export type SetupLog = {
  status: "none" | "running" | "ok" | "failed";
  exitCode?: number;
  log: string;
};

/** What a new task asks for: the project's working tree, or its own worktree. */
export type WorkspaceMode = "project" | "worktree";

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

export type UIMessagePart = UIMessage["parts"][number];
