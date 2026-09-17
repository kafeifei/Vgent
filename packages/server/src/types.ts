import type { HarnessAgentResumeSessionState } from "@vgent/engines";
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

/** One task. Persisted whole in `threads/<id>.json`. */
export interface ThreadRecord {
  version: 1;
  id: string;
  projectId: string;
  title: string;
  engine: EngineId;
  model?: string;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  error?: string;
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
}

/**
 * Harness resume state for one thread, in `threads/<id>.harness.json` (0600).
 * It can carry bridge credentials, so it is never served over HTTP or SSE.
 */
export interface HarnessState {
  version: 1;
  sessionId: string;
  resumeFrom: HarnessAgentResumeSessionState;
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
