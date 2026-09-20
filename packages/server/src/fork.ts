/**
 * 分叉: a new task that starts from an earlier point of this one's conversation.
 *
 * The point is a user message. The fork gets every message before it, and that
 * message's own text comes back as a draft — the user is branching because they
 * want to say something different there, so it goes into the composer to be
 * edited, not into the history to be re-run as it was.
 *
 * Only the conversation forks. The files are whatever the new task's working
 * directory holds; nothing on disk is copied or rolled back.
 */
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { NotFoundError } from "./errors.js";
import type { ThreadMessageMetadata } from "./types.js";

export interface ForkPlan {
  /** The history the new task starts with: copies, under ids of their own. */
  messages: UIMessage[];
  /** The text of the message forked at, for the new task's composer. */
  draft: string;
}

const textOf = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

/**
 * A checkpoint names a commit in the *source* task's snapshot history; carried
 * over, it would let the fork "restore" a directory it never ran in.
 */
function withoutCheckpoints(message: UIMessage): UIMessage {
  const metadata = message.metadata as ThreadMessageMetadata | undefined;
  if (metadata == null) return { ...message, id: randomUUID() };
  const { checkpoint: _before, checkpointAfter: _after, ...rest } = metadata;
  const { metadata: _dropped, ...bare } = message;
  return { ...bare, id: randomUUID(), ...(Object.keys(rest).length > 0 ? { metadata: rest } : {}) };
}

export function planFork(messages: readonly UIMessage[], messageId: string): ForkPlan {
  const index = messages.findIndex((message) => message.id === messageId);
  const at = messages[index];
  if (at == null || at.role !== "user") throw new NotFoundError(`这个任务里没有用户消息 ${JSON.stringify(messageId)}`, "message_not_found");
  return { messages: messages.slice(0, index).map(withoutCheckpoints), draft: textOf(at) };
}

/** The transcript handed over is the tail of the conversation, capped: the recent turns are the ones the next message leans on. */
const FORK_NOTE_MAX_CHARS = 60_000;

/**
 * 分叉后的第一轮, for an engine whose session keeps its own history (Claude
 * Code, Codex). Such a session reads only the last user message, and a fork has
 * no session yet — so what was said before travels once, as text, on that
 * message. The in-house engine is sent the copied messages themselves and needs
 * none of this.
 */
export function forkNote(messages: readonly UIMessage[]): string | undefined {
  const lines = messages.flatMap((message) => {
    const text = textOf(message);
    return text === "" ? [] : [`【${message.role === "user" ? "用户" : "助手"}】\n${text}`];
  });
  if (lines.length === 0) return undefined;
  const transcript = lines.join("\n\n");
  const tail = transcript.length > FORK_NOTE_MAX_CHARS ? `（更早的部分已省略）\n…${transcript.slice(-FORK_NOTE_MAX_CHARS)}` : transcript;
  return `（这个任务是从另一个任务的对话中途分叉出来的。下面是分叉点之前的对话记录，只含文字、不含工具调用；当时改过的文件现在是什么样，以磁盘上的为准。）\n\n${tail}`;
}
