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
  ChangeStatus,
  ChangesSnapshot,
  EngineId,
  FileContent,
  FileDiff,
  FileEntry,
  FileListing,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  ModelCatalog,
  ModelEntry,
  PermissionMode,
  Project,
  Settings,
  ThreadMessageMetadata,
  ThreadRecord,
  ThreadStatus,
  ThreadSummary,
  ThreadWorkspace,
  UsageInfo,
} from "@vgent/server";

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

export type UIMessagePart = UIMessage["parts"][number];
