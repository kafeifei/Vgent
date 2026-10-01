import type { TaskState } from "@vgent/engine";
import type { McpServerConfig } from "@vgent/engine";
import type { HarnessAgentContinueTurnState, HarnessAgentResumeSessionState } from "@vgent/engines";
import type { FileUIPart, UIMessage } from "ai";

export type EngineId = "claude-code" | "codex" | "vgent" | "opencode";
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
  /** Why it failed, as the one sentence shown under 「运行 setup 脚本失败」. */
  error?: string;
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
  /**
   * When 「创建 worktree」 started and finished — made new, or put back by
   * 取消归档. Absent on a task from before it was kept.
   */
  created?: { startedAt: string; finishedAt: string };
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
  /** Normalized input includes both cache buckets; absent on pre-fix OpenCode records. */
  inputTokensIncludeCache?: true;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Of `inputTokens`, the part that was read from the provider's prompt cache. */
  cachedInputTokens?: number;
  /** Of `inputTokens`, the part written to the prompt cache — Anthropic bills it above fresh input. */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * The working directory as it was right before — or right after — one turn,
 * kept as a git commit under `refs/vgent/checkpoints/<threadId>/`. 「恢复到此处」
 * puts the files back to it; the conversation is never touched.
 */
export interface MessageCheckpoint {
  commit: string;
  ref: string;
  at: string;
}

/**
 * 恢复后停在哪里: the task's working directory currently holds the state from
 * before `messageId` ran, and every turn from there on has had its file changes
 * undone. The messages themselves are all still there, rendered dimmed.
 *
 * `undoCommit` is the whole-tree snapshot taken before the *first* restore of
 * this stretch, which is what 「回到最新」 goes back to. Restoring again while
 * this is set keeps it: a snapshot of an already-restored tree is not 最新.
 * Cleared when the user sends the next message, or by 「回到最新」 itself.
 */
/** Which way an 归档 whose worktree work has not finished yet is going. */
export type ThreadTransition = "archiving" | "unarchiving";

export interface ThreadRestorePoint {
  messageId: string;
  undoCommit: string;
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
  /**
   * All of the turn's steps summed, for cost rather than context. While the
   * turn runs it is the sum of the steps so far; its `finish` settles it.
   */
  totalUsage?: UsageInfo;
  /**
   * On the marker a 压缩 appends: a user message whose text is the summary.
   * The history before it stays; what the model reads from here on is this
   * summary, the messages from `keptFrom` up to the marker (the latest turns,
   * kept word for word), and whatever comes after. `before` is how many
   * messages the summary stands for. The work log draws the marker as a line
   * that opens the summary in the right pane.
   *
   * An older build left the same field on a summary that *replaced* the
   * history, followed by an acknowledgement; it reads the same way.
   */
  compacted?: { before: number; at: string; keptFrom?: string };
  /** A native /compact request. Completion is recorded by the turn's run, not at submission. */
  compactRequested?: { at: string };
  /**
   * On a user message: the snapshot taken right before the turn it started.
   * Absent when the task's directory is not a git repo, or the snapshot failed.
   */
  checkpoint?: MessageCheckpoint;
  /**
   * On the same user message: the snapshot taken once that turn really ended.
   * The two together name the files the turn touched. Absent for a turn that
   * never ended (a crash, a turn abandoned mid-approval) and for every turn of
   * a task that ran before after-snapshots existed — such a span falls back to
   * restoring the whole tree.
   */
  checkpointAfter?: MessageCheckpoint;
  /**
   * On the same user message: how its turn ended, when that was not a normal
   * finish — it failed, was stopped, or the server went down under it. The
   * thread's own `error` only ever describes the latest turn and is cleared by
   * the next one, which used to leave an earlier failure as a question with no
   * answer under it. Cleared again when the turn is picked back up.
   */
  turnEnd?: TurnEnd;
  run?: {
    id: string;
    engine: EngineId;
    model?: string;
    provider?: string;
    startedAt: string;
    endedAt?: string;
    stopReason: string;
    lastEvent?: string;
    finishReason?: string;
    steps?: number;
    providerAttempts?: number;
    errorClass?: string;
  };
}

export interface TurnEnd {
  status: "error" | "interrupted";
  /** Why, in the words the log shows. */
  reason: string;
}

/** Where a forked task came from. */
export interface ThreadForkOrigin {
  threadId: string;
  messageId: string;
  pending?: true;
}

/** What `POST /api/threads/:id/checkpoints/restore` answers with. */
export interface CheckpointRestore {
  /** The checkpoint commit the working directory now matches. */
  restored: string;
  /** The state that was just replaced, kept as this thread's safety copy. */
  undo: string;
  /** Where the thread now stands; absent means it is back at 最新. */
  restoredTo?: ThreadRestorePoint;
  /** How many files were written or removed. */
  files: number;
  /** True when the span had a turn with no after-snapshot, so the whole tree moved. */
  whole: boolean;
  changeStats?: ChangeStats;
}

/** What `GET /api/threads/:id/checkpoints/preview` answers with: what a restore would do, before it does it. */
export interface CheckpointPreview {
  /** Files the restore would touch. Meaningless when `whole`. */
  files: number;
  whole: boolean;
}

/**
 * 收口态: how a task's changes left the workbench. Absent means the task still
 * owns its diff. Cleared when a new turn starts, because the task is working
 * again and whatever it did before is no longer the whole story.
 */
export interface ThreadOutcome {
  /** `pushed`: the branch went up but the PR has to be opened on the host's own site. */
  kind: "committed" | "pr" | "applied" | "discarded" | "pushed";
  at: string;
  /** The commit sha for `committed`; the pushed branch for `pushed`. */
  ref?: string;
  /** The pull request, for `pr`. */
  url?: string;
}

/**
 * 开 PR 留下的链接, kept apart from `outcome` on purpose: a new turn clears the
 * 收口态, but an opened PR goes on existing, so its link must survive.
 *
 * `kind` says what the link is. `pr` is a real pull request — `gh` created it,
 * or it was already there. `compare` is GitHub's compare page, which is as far
 * as we can get without `gh`: the branch is pushed and the user presses Create
 * on GitHub's own form.
 */
export interface ThreadPullRequest {
  url: string;
  /** Only a real pull request has one. */
  number?: number;
  kind: "pr" | "compare";
  /** The branch that was pushed. */
  branch?: string;
  at: string;
}

/**
 * 撤销带回 的依据: the project checkout as it was right before 带回主目录 wrote
 * to it, plus a fingerprint of everything that apply left behind.
 *
 * The fingerprints are what make the undo safe to offer later: a file whose
 * content is still exactly what apply wrote can be put back, and one the user
 * has since edited is left alone rather than silently reverted.
 */
export interface ApplyUndoRecord {
  /** Checkpoint commit holding the whole project checkout from before the apply. */
  snapshot: string;
  /** Every path apply wrote or deleted, with the content hash it left (`null` = deleted). */
  files: { path: string; hash: string | null }[];
  at: string;
}

/**
 * 排队: one message typed while a turn was live, waiting its turn on the
 * server. It outlives the browser — the run manager sends the head of the queue
 * itself once a turn settles back to `idle`.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Original attachments, consumed atomically with the queued user message. */
  files?: FileUIPart[];
  createdAt: string;
  /** Missing on older records: a normal next-turn queue item. */
  mode?: "queue" | "steer";
  /** A push engine acknowledged receipt, but has not confirmed model consumption. */
  accepted?: boolean;
  /** Persisted before calling the runtime, to block editing during delivery. */
  delivering?: boolean;
  /** A manual send has reserved this item while the old turn stops. */
  promoting?: boolean;
  /** Normal queued input reserved before its user message is atomically committed. */
  claimed?: boolean;
  /** The runtime reported this message entered the active turn. */
  applied?: boolean;
}

/** State/index payloads describe attachments without broadcasting their bytes. */
export type QueuedMessageSummary = Omit<QueuedMessage, "files"> & {
  files?: Pick<FileUIPart, "type" | "filename" | "mediaType">[];
};

/** The task's diff against its baseline, in three numbers, for the sidebar. */
export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
}

/** One task. Persisted whole in `threads/<id>.json`. */
export interface ThreadRecord {
  /** Durable auto-continuation intent after a crash; value is the recovery message id. */
  restartRecovery?: string;
  taskState?: TaskState;
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
  /**
   * The service tier the task's turns are run on — `priority` is what Codex's
   * catalog calls Fast. A plain string for the same reason `reasoningEffort`
   * is: the model catalog says which ids a model offers. Absent means the
   * standard tier.
   */
  serviceTier?: string;
  /**
   * The context window the task's turns are run with, in tokens — one of the
   * model's `contextOptions`. Absent means the engine's own window for that
   * model — for Claude Code, its standard 200K. What it turns into is each
   * engine's: Codex's `model_context_window`, Claude Code's `[1m]` model suffix
   * and compaction window, the in-house engine's pruning budget.
   */
  contextWindow?: number;
  /** 模式 for the next turn. Absent means `agent`; only a Plan-capable engine may carry `plan`. */
  mode?: ThreadMode;
  status: ThreadStatus;
  error?: string;
  /**
   * 未读: the task changed while nobody was looking. Set by the run manager when
   * a turn leaves `running` by itself — finished, failed, or parked on the
   * human — and cleared by the client once the task is on screen in a focused
   * window (or by hand, from the sidebar row's menu). Absent means 已读; 停止
   * never sets it, because the user is the one who pressed it.
   */
  unread?: boolean;
  /** Deferred worktree creation; absent once the worktree is ready. */
  workspaceState?: "creating" | "failed";
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
  /** The PR (or compare page) 开 PR opened. Outlives `outcome`, which a new turn clears. */
  pr?: ThreadPullRequest;
  /** What the last 带回主目录 can be undone from. Replaced by the next apply, dropped on 归档 and 删除. */
  applyUndo?: ApplyUndoRecord;
  /**
   * 恢复后停在哪里. Present only while the working directory sits at an earlier
   * checkpoint; the next message the user sends clears it. On the summary too,
   * because the work log dims from this point down.
   */
  restoredTo?: ThreadRestorePoint;
  /**
   * 分叉来源. `pending` stays until the fork's first turn starts: that turn is
   * the one that has to carry the earlier conversation to an engine whose
   * session does not have it.
   */
  forkedFrom?: ThreadForkOrigin;
  /** Recomputed at the end of every turn and after every 收口 action. */
  changeStats?: ChangeStats;
  /** 排队的消息, oldest first. Never stored empty — an absent field is an empty queue. */
  queue?: QueuedMessage[];
  /** Set when the task was archived; its worktree is reclaimed at the same time. */
  archivedAt?: string;
  /**
   * 归档中 / 恢复中: `archivedAt` already says where the task is going, and its
   * worktree is still being snapshotted away or put back. Absent once that is done.
   */
  transition?: ThreadTransition;
  /**
   * The user's say-so that 归档 takes the worktree's uncommitted changes along
   * — Fumie's `preserveChanges` receipt. Stored with the move, so a restart
   * finishes it the same way; a move without it touches nothing dirty.
   */
  archivePreserveChanges?: true;
  /**
   * 压缩中: a summary is being written. No turn starts meanwhile — sending
   * queues — and the log shows it. `error` is why the last one failed, until
   * the next attempt or the next turn.
   */
  compaction?: { startedAt: string; error?: string };
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
}

/**
 * What the thread list and the `/api/state` SSE carry: the record minus its
 * messages, and minus the 撤销带回 record — a per-file bookkeeping list nothing
 * outside the task's own 收口 has any use for, and one that would ride along in
 * every state push.
 */
export interface ThreadSummary extends Omit<ThreadRecord, "messages" | "applyUndo" | "queue"> {
  queue?: QueuedMessageSummary[];
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
  /**
   * 订阅模型的开关: what an agent gets from a login (Claude 订阅, Codex 订阅) is
   * all on until the user switches one off in the 模型 table — this is the off
   * list, per agent, in the ids a task's `model` takes. It only trims the
   * picker; a task that already names the model keeps running on it.
   */
  hiddenModels?: Partial<Record<EngineId, string[]>>;
  /**
   * 系统通知: whether a finished turn — or one that needs the user — calls them
   * back through the OS while the window is not focused. Absent means on, so an
   * older settings file needs no migration.
   */
  systemNotifications?: boolean;
  /**
   * 自动升级引擎运行时: whether Claude Code / Codex are moved to their newest
   * release on their own while no task of that engine runs. Absent means on —
   * an upgrade is verified before it counts and rolled back if a turn cannot
   * start on it, which is what makes doing it unasked safe.
   */
  autoUpgradeRuntimes?: boolean;
  /**
   * 记住上次选择, by `ModelEntry.modelKey`: the engine a model last ran on and
   * what it ran with. Picking the model again brings them back, and a new task
   * on it starts with them. On the server rather than in the browser because
   * the desktop app's origin changes with its port.
   */
  modelPicks?: Record<string, ModelPick>;
  /**
   * 提供商排序: the settings page's「已添加」list as the user dragged it, by
   * subscription id (`codex-subscription`, `claude-subscription`) or provider id.
   * The model picker groups its rows in this order. One that is not in it — a
   * provider connected since — follows the ones that are.
   */
  providerOrder?: string[];
  /** MCP servers the `vgent` engine connects to per turn. Their tools are deferred; see `connectMcpServers`. */
  mcpServers?: McpServerConfig[];
  /** The built-in desktop-control backend. Absent means Computer Use is off. */
  computerUseProvider?: "cua" | null;
  /** How many live worktrees to keep before the oldest idle ones are reclaimed. Absent = `DEFAULT_WORKTREE_MAX_COUNT`. */
  worktreeMaxCount?: number;
  /**
   * 运行位置, 记住上一次选择: what the last task started in a project ran in, so
   * the next one starts there too. Absent = 主目录. A 无项目 task has no choice
   * to make, so it leaves this alone.
   */
  defaultWorkspace?: "project" | "worktree";
  /**
   * 界面偏好, kept here rather than in the browser: the desktop shell's WebView
   * gets a new origin on every launch, so `localStorage` alone would forget
   * them. Absent = the built-in default (深色 / 舒适).
   */
  theme?: UiTheme;
  density?: UiDensity;
}

/**
 * What one model was last picked with. An absent field is the model's own
 * default: its default engine (see the web's `preferredRoute`), and whatever
 * level, tier and window the catalog gives it.
 */
export interface ModelPick {
  engine?: EngineId;
  reasoningEffort?: string;
  serviceTier?: string;
  contextWindow?: number;
}

/** 主题: dark remains the default; system follows the OS appearance. */
export type UiTheme = "dark" | "light" | "system";
/** 密度 of the list rows and the log. */
export type UiDensity = "comfortable" | "compact";

/**
 * Harness resume state for one thread, in `threads/<id>.harness.json` (0600).
 * It can carry bridge credentials, so it is never served over HTTP or SSE.
 */
export interface HarnessState {
  version: 1;
  sessionId: string;
  /** The last *finished* turn's session, written by the engine runner's `finish()`. */
  resumeFrom?: HarnessAgentResumeSessionState;
  /** Native Codex app-server session; older harness sessions use resumeFrom.data.threadId. */
  codexThreadId?: string;
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
