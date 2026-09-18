/**
 * 恢复只回退任务动过的文件: turning 「恢复到这条消息之前」 into a file list.
 *
 * A task is a row of turns, and every turn a user message started carries two
 * snapshots: the tree it began with and the tree it ended with. The files that
 * turn touched are the difference between the two, so a restore that spans
 * turns k…m only has to put *those* files back — everything else on disk is the
 * user's own and is left exactly where it is.
 *
 * Moving forward again is the same rule read the other way: from where the
 * thread currently stands to the message it is going to, with the turns in
 * between naming the files. A span containing a turn with no after-snapshot (a
 * crash, a turn abandoned mid-approval, a task older than this) cannot be
 * reduced to a file list at all, and falls back to the whole tree — which is
 * what a restore always used to do. The caller says so out loud before doing it.
 *
 * Everything here is pure except `planRestore`, which runs one `git diff` per
 * turn in the span.
 */
import type { UIMessage } from "ai";
import { changedPaths } from "./checkpoints.js";
import type { ToolExec } from "./exec.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { ThreadMessageMetadata, ThreadRecord, ThreadRestorePoint } from "./types.js";

/** One turn, as the checkpoints see it. */
export interface TurnSnapshots {
  /** The user message that started it. */
  messageId: string;
  /** The tree the turn began with. */
  before: string;
  /** The tree it ended with; absent for a turn that never ended. */
  after?: string;
}

/** Every turn of a thread that has a checkpoint, oldest first. */
export function turnSnapshots(messages: readonly UIMessage[]): TurnSnapshots[] {
  const turns: TurnSnapshots[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const metadata = message.metadata as ThreadMessageMetadata | undefined;
    if (metadata?.checkpoint == null) continue;
    turns.push({
      messageId: message.id,
      before: metadata.checkpoint.commit,
      ...(metadata.checkpointAfter != null ? { after: metadata.checkpointAfter.commit } : {}),
    });
  }
  return turns;
}

/**
 * 「上一轮」: the two trees the 变更 panel's second scope diffs. The task needs at
 * least two turns for it to say anything the 全部改动 view does not already, and
 * the last one has to have ended.
 */
export function lastTurnPair(messages: readonly UIMessage[]): { from: string; to: string } | undefined {
  const turns = turnSnapshots(messages);
  const last = turns.at(-1);
  if (turns.length < 2 || last?.after == null) return undefined;
  return { from: last.before, to: last.after };
}

/** 恢复到哪里: a message to stand before, or all the way back to 最新. */
export type RestoreTarget = { messageId: string } | { latest: true };

/** A request body's restore target. Throws on anything that is neither. */
export function asRestoreTarget(body: unknown): RestoreTarget {
  const { messageId, latest } = (body ?? {}) as { messageId?: unknown; latest?: unknown };
  const byMessage = typeof messageId === "string" && messageId.length > 0;
  const byLatest = latest === true;
  if (byMessage === byLatest) throw new BadRequestError("需要 messageId 或 latest，二选一", "invalid_checkpoint");
  return byMessage ? { messageId: messageId as string } : { latest: true };
}

/** What a restore is about to do. */
export interface RestorePlan {
  /** The checkpoint commit the working directory is put back to. */
  commit: string;
  /** Only these files move. Absent means the whole tree, which is what `whole` says. */
  paths?: string[];
  /** How many files move. Meaningless when `whole`. */
  files: number;
  /** True when the span holds a turn with no after-snapshot, so nothing narrower than the tree is honest. */
  whole: boolean;
  /** Where the thread stands afterwards; absent means back at 最新. */
  at?: string;
}

/**
 * Work out the target tree and the files to move, without touching the working
 * directory.
 *
 * `known` is the set of commits this thread may be restored to (its own
 * checkpoint refs). A span whose snapshots retention has already dropped cannot
 * be diffed, so it degrades to the whole tree rather than failing.
 */
export async function planRestore(options: {
  repoPath: string;
  thread: Pick<ThreadRecord, "messages" | "restoredTo">;
  target: RestoreTarget;
  /** Commits this thread may be restored to; a target outside it is a 404. */
  known: ReadonlySet<string>;
  exec?: ToolExec;
}): Promise<RestorePlan> {
  const { repoPath, thread, target, known } = options;
  const turns = turnSnapshots(thread.messages);
  const restoredTo: ThreadRestorePoint | undefined = thread.restoredTo;
  // Where the working directory stands now. `-1` is a marker whose message is
  // gone (`/compact` replaced the history): the span is unknowable, so the
  // restore below widens to the whole tree.
  const position = restoredTo == null ? turns.length : turns.findIndex((turn) => turn.messageId === restoredTo.messageId);

  let commit: string;
  let destination: number;
  let at: string | undefined;
  if ("latest" in target) {
    if (restoredTo == null) throw new BadRequestError("这个任务没有被恢复过，没有可回到的状态", "not_restored");
    commit = restoredTo.undoCommit;
    destination = turns.length;
  } else {
    const index = turns.findIndex((turn) => turn.messageId === target.messageId);
    if (index < 0) throw new NotFoundError("这条消息没有快照", "checkpoint_not_found");
    commit = turns[index]!.before;
    destination = index;
    at = target.messageId;
  }
  if (!known.has(commit)) throw new NotFoundError("快照已不存在", "checkpoint_not_found");

  const from = Math.min(position < 0 ? turns.length : position, destination);
  const span = turns.slice(from, Math.max(position < 0 ? turns.length : position, destination));
  const whole = position < 0 || span.some((turn) => turn.after == null || !known.has(turn.before) || !known.has(turn.after));
  if (whole) return { commit, files: 0, whole: true, ...(at != null ? { at } : {}) };

  const paths = new Set<string>();
  for (const turn of span) {
    for (const path of await changedPaths({ repoPath, from: turn.before, to: turn.after!, ...(options.exec != null ? { exec: options.exec } : {}) })) {
      paths.add(path);
    }
  }
  return { commit, paths: [...paths], files: paths.size, whole: false, ...(at != null ? { at } : {}) };
}

/** How much of a user message goes into the one sentence the model is told. */
const NOTE_EXCERPT_MAX_LEN = 30;

/**
 * 恢复之后再发消息: the one sentence the next turn's input carries, so the model
 * does not spend the turn confused about files it remembers writing.
 *
 * Told once, in that turn's *model* messages only — the stored conversation
 * keeps the user's own words untouched.
 */
export function restoreNote(messages: readonly UIMessage[], messageId: string): string {
  const message = messages.find((entry) => entry.id === messageId);
  const text = message?.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  const where = text == null || text === "" ? "更早的一条消息" : `「${text.slice(0, NOTE_EXCERPT_MAX_LEN)}」`;
  return `（系统提示）用户已把工作目录恢复到${where}发出之前的状态，那之后各轮改过的文件都已撤销，请以磁盘上的当前内容为准。`;
}
