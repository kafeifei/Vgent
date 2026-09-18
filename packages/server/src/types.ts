import type { McpServerConfig } from "@vgent/engine";
import type { HarnessAgentContinueTurnState, HarnessAgentResumeSessionState } from "@vgent/engines";
import type { UIMessage } from "ai";

export type EngineId = "claude-code" | "codex" | "vgent";
export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";
export type ThreadStatus = "idle" | "running" | "awaiting-approval" | "awaiting-input" | "interrupted" | "error";

/**
 * 模式: what the *next* turn on a task does. `agent` goes straight to work;
 * `plan` researches read-only and leaves its answer in the task's 计划文档,
 * which the user edits before pressing Build (which switches back to `agent`).
 */
export type ThreadMode = "plan" | "agent";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
}

/**
 * How the project's worktree setup script went for this task. Absent means the
 * project has no `worktrees.json`, so nothing was ever run.
 */
export interface WorkspaceSetup {
  status: "running" | "ok" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
}

/**
 * Where a task's files live, when that is not the project's own working tree.
 * Absent means the task edits the project directly.
 */
export interface ThreadWorkspace {
  mode: "worktree";
  /** `<dataDir>/worktrees/<threadId>`, with its parent fully resolved. */
  path: string;
  branch: string;
  /** The project commit the worktree started from. */
  baseCommit: string;
  /** Set once the directory has been snapshotted and removed. */
  reclaimed?: boolean;
  /** The snapshot a reclaimed worktree can be restored from. */
  snapshotPath?: string;
  /** Progress of the project's setup script; absent means there was none to run. */
  setup?: WorkspaceSetup;
}

/**
 * Token counts of one model call, flattened out of the AI SDK v7
 * `LanguageModelUsage` (whose cache / reasoning splits live in nested
 * `inputTokenDetails` / `outputTokenDetails`).
 *
 * Every field is optional because a provider may report none of them. The one
 * the client really uses is `inputTokens`: it is the *whole* prompt a call sent,
 * cache reads included, which is exactly how much context the thread occupies.
 */
export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Of `inputTokens`, the part that was read from the provider's prompt cache. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * The working directory as it was right before one turn started, kept as a git
 * commit under `refs/vgent/checkpoints/<threadId>/`. 「恢复到此处」 puts the
 * files back to it; the conversation is never touched.
 */
export interface MessageCheckpoint {
  commit: string;
  ref: string;
  at: string;
}

/**
 * `UIMessage.metadata` on a message this server persisted.
 *
 * The usage fields are assistant-only, attached by the run manager's
 * `toUIMessageStream({ messageMetadata })` so every engine whose stream reports
 * usage gets them. `checkpoint` is the one user-message field: the snapshot the
 * turn that message started was taken from. Deliberately *not* mirrored onto
 * `ThreadSummary`: the client derives the context ring from `messages`, and the
 * thread list has no use for any of it.
 */
export interface ThreadMessageMetadata {
  /** The last step's usage — its `inputTokens` is the context size at turn end. */
  usage?: UsageInfo;
  /** All of the turn's steps summed, for cost rather than context. */
  totalUsage?: UsageInfo;
  /**
   * On the summary message `/compact` left behind: how many messages it
   * replaced, and when. The work log renders a marker from it.
   */
  compacted?: { before: number; at: string };
  /**
   * On a user message: the snapshot taken right before the turn it started.
   * Absent when the task's directory is not a git repo, or the snapshot failed.
   */
  checkpoint?: MessageCheckpoint;
}

/** What `POST /api/threads/:id/checkpoints/restore` answers with. */
export interface CheckpointRestore {
  /** The checkpoint commit the working directory now matches. */
  restored: string;
  /** The state that was just replaced, kept so 撤销 can put it back. */
  undo: string;
  changeStats?: ChangeStats;
}

/**
 * 收口态: how a task's changes left the workbench. Absent means the task still
 * owns its diff. Cleared when a new turn starts, because the task is working
 * again and whatever it did before is no longer the whole story.
 */
export interface ThreadOutcome {
  kind: "committed" | "pr" | "applied" | "discarded";
  at: string;
  /** The commit sha, for `committed`. */
  ref?: string;
  /** The pull request, for `pr`. */
  url?: string;
}

/**
 * 排队: one message typed while a turn was live, waiting its turn on the
 * server. It outlives the browser — the run manager sends the head of the queue
 * itself once a turn settles back to `idle`.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: string;
}

/** The task's diff against its baseline, in three numbers, for the sidebar. */
export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
}

/** One task. Persisted whole in `threads/<id>.json`. */
export interface ThreadRecord {
  version: 1;
  id: string;
  projectId: string;
  title: string;
  engine: EngineId;
  model?: string;
  /**
   * 「思考等级」: how hard the engine is asked to reason. Deliberately a plain
   * string — each engine names its own levels (`low`/`medium`/`high`/`xhigh`
   * for the OpenAI side, `disabled`/`adaptive`/`enabled` for Claude Code), and
   * the model catalog is what tells the UI which ones a model offers. Absent
   * means「用引擎自己的默认」.
   */
  reasoningEffort?: string;
  /** 模式 for the next turn. Absent means `agent`; only a Plan-capable engine may carry `plan`. */
  mode?: ThreadMode;
  status: ThreadStatus;
  error?: string;
  /** Present only for a task running in its own git worktree. */
  workspace?: ThreadWorkspace;
  /**
   * 任务基线 of a task that edits the project directly: the working directory as
   * its first turn found it, kept as a commit under
   * `refs/vgent/checkpoints/<id>/base`. Everything 改动 and 提交 look at is
   * measured against it, so the user's own uncommitted work never counts as the
   * task's. A worktree task uses `workspace.baseCommit` instead, and a task from
   * before this existed has neither — it falls back to `HEAD`.
   */
  baselineCommit?: string;
  /** How the task was wound up — 提交 / PR / 带回主目录 / 丢弃. */
  outcome?: ThreadOutcome;
  /** Recomputed at the end of every turn and after every 收口 action. */
  changeStats?: ChangeStats;
  /** 排队的消息, oldest first. Never stored empty — an absent field is an empty queue. */
  queue?: QueuedMessage[];
  /** Set when the task was archived; its worktree is reclaimed at the same time. */
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
}

/** What the thread list and the `/api/state` SSE carry: the record minus its messages. */
export interface ThreadSummary extends Omit<ThreadRecord, "messages"> {
  messageCount: number;
  pendingApprovals: number;
}

export interface Settings {
  defaultEngine: EngineId;
  /**
   * 运行模式: one global three-way choice, applied to every task. An engine
   * without the `approvals` capability runs 全自动 whatever this says — see
   * `effectivePermission`.
   */
  runMode: PermissionMode;
  /**
   * Tools the user said to never ask about again (审批卡上的「一直允许」).
   * Global, like the mode above; deduped, non-empty names.
   */
  allowlist: string[];
  defaultModel?: string;
  /** MCP servers the `vgent` engine connects to per turn. Their tools are deferred; see `connectMcpServers`. */
  mcpServers?: McpServerConfig[];
  /** How many live worktrees to keep before the oldest idle ones are reclaimed. Absent = `DEFAULT_WORKTREE_MAX_COUNT`. */
  worktreeMaxCount?: number;
}

/**
 * Harness resume state for one thread, in `threads/<id>.harness.json` (0600).
 * It can carry bridge credentials, so it is never served over HTTP or SSE.
 */
export interface HarnessState {
  version: 1;
  sessionId: string;
  /** The last *finished* turn's session, written by the engine runner's `finish()`. */
  resumeFrom?: HarnessAgentResumeSessionState;
  /**
   * An *unfinished* turn frozen by `EngineRunner.suspend()` on graceful
   * shutdown. Its bridge is still running, so this is only ever valid while
   * that process group lives; the next turn on the thread either attaches to it
   * or clears it.
   */
  continueFrom?: HarnessAgentContinueTurnState;
  updatedAt: string;
}

export interface ConnectionInfo {
  version: 1;
  url: string;
  token: string;
  pid: number;
  createdAt: string;
}

/** Minimal logger so nothing in this package reaches for `console` directly. */
export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (message, ...rest) => console.log(message, ...rest),
  warn: (message, ...rest) => console.warn(message, ...rest),
  error: (message, ...rest) => console.error(message, ...rest),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
