import type { UIMessage } from "ai";

export type PermissionMode = "allow-reads" | "allow-edits" | "allow-all";

export type ThreadStatus =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "awaiting-input"
  | "interrupted"
  | "error";

export type Project = {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
};

export type ThreadSummary = {
  id: string;
  projectId: string;
  title: string;
  engine: string;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = ThreadSummary & {
  messages: UIMessage[];
};

/** Payload of the `state` event on `GET /api/state`. */
export type StateEvent = {
  projects: Project[];
  threads: ThreadSummary[];
  settings: Record<string, unknown>;
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

/** Output shape of the `askUserQuestions` tool. */
export type AskUserQuestionsOutput =
  | {
      action: "answered" | "partially-answered";
      answers: Record<string, { optionIds: string[]; freeform?: string }>;
    }
  | { action: "declined" }
  | { action: "cancelled" };
