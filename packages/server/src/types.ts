import type { McpServerConfig } from "@vgent/engine";
import type { HarnessAgentContinueTurnState, HarnessAgentResumeSessionState } from "@vgent/engines";
import type { UIMessage } from "ai";

export type EngineId = "claude-code" | "codex" | "vgent";
export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";
export type ThreadStatus = "idle" | "running" | "awaiting-approval" | "awaiting-input" | "interrupted" | "error";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
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
}

/** One task. Persisted whole in `threads/<id>.json`. */
export interface ThreadRecord {
  version: 1;
  id: string;
  projectId: string;
  title: string;
  engine: EngineId;
  model?: string;
  permissionMode: PermissionMode;
  /**
   * Tools the user said to always allow in this task (「本任务内一直允许」).
   * Deduped, non-empty names; absent means nothing is pre-allowed.
   */
  alwaysAllow?: string[];
  status: ThreadStatus;
  error?: string;
  /** Present only for a task running in its own git worktree. */
  workspace?: ThreadWorkspace;
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
  defaultPermissionMode: PermissionMode;
  defaultModel?: string;
  /** MCP servers the `vgent` engine connects to per turn. Their tools are deferred; see `connectMcpServers`. */
  mcpServers?: McpServerConfig[];
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
