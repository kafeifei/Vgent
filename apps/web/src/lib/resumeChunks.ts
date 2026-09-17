import { getToolName, isToolUIPart, type UIMessage, type UIMessageChunk } from "ai";
import type { UIMessagePart } from "./types";

/**
 * Makes a replayed stream self-contained, so `chat.resumeStream()` can rebuild
 * the assistant message it addresses.
 *
 * `Chat.makeRequest` builds the streaming state for `trigger: 'resume-stream'`
 * with `lastMessage: undefined` (ai@7.0.105, `dist/index.js:21959`), i.e. from a
 * blank message — the replay is expected to carry every chunk of the message it
 * is rebuilding. That holds for a turn the server started fresh, but not for a
 * turn that *continues* the previous assistant message (an approval answer, a
 * client tool result): `toUIMessageStream({ originalMessages })` reuses that
 * message's id and streams only the new chunks, which address parts the blank
 * state does not have. The first such chunk throws:
 *
 *     No tool invocation found for approval ID "toolu_…"
 *
 * — and takes the whole turn down with it. The client already holds those parts
 * (loaded from `GET /api/threads/:id`), so the repair is local: replay them as
 * the chunks that would have built them, right after the stream's `start`.
 */
export function withResumePrelude(
  stream: ReadableStream<UIMessageChunk>,
  resumed: UIMessage | undefined,
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader();
  let pending: UIMessageChunk[] = [];
  /** Until the first chunk after `start` says which kind of replay this is. */
  let deciding = false;
  let started = false;

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        if (pending.length > 0) {
          controller.enqueue(pending.shift() as UIMessageChunk);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        if (!started) {
          started = true;
          // A replay that does not open the message we hold is none of our
          // business: it builds its own message from scratch.
          deciding = resumed != null && value.type === "start" && value.messageId === resumed.id;
          controller.enqueue(value);
          return;
        }

        if (deciding) {
          deciding = false;
          // A chunk that addresses a part no earlier chunk of this stream could
          // have created is the tell-tale of a continuation turn.
          if (resumed != null && continuesExistingPart(value)) pending = messageChunks(resumed);
        }
        pending.push(value);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** Chunks that update a tool part instead of creating one. */
function continuesExistingPart(chunk: UIMessageChunk): boolean {
  return (
    chunk.type === "tool-approval-request" ||
    chunk.type === "tool-approval-response" ||
    chunk.type === "tool-output-available" ||
    chunk.type === "tool-output-error" ||
    chunk.type === "tool-output-denied"
  );
}

/**
 * An assistant message's parts, as the chunks that would have produced them.
 *
 * Only what this app's engines actually emit is covered; an unknown part is
 * skipped rather than guessed at. Ids for text and reasoning are synthesized —
 * the originals are not kept on the parts, and nothing downstream needs them
 * beyond pairing start/delta/end.
 */
export function messageChunks(message: UIMessage): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [];
  message.parts.forEach((part, index) => {
    chunks.push(...partChunks(part, `resume-${index}`));
  });
  return chunks;
}

function partChunks(part: UIMessagePart, id: string): UIMessageChunk[] {
  if (isToolUIPart(part)) return toolChunks(part);

  switch (part.type) {
    case "step-start":
      return [{ type: "start-step" }];
    case "text":
      return [
        { type: "text-start", id },
        { type: "text-delta", id, delta: part.text },
        ...(part.state === "streaming" ? [] : [{ type: "text-end" as const, id }]),
      ];
    case "reasoning":
      return [
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: part.text },
        ...(part.state === "streaming" ? [] : [{ type: "reasoning-end" as const, id }]),
      ];
    case "file":
      return [{ type: "file", url: part.url, mediaType: part.mediaType }];
    case "reasoning-file":
      return [{ type: "reasoning-file", url: part.url, mediaType: part.mediaType }];
    case "source-url":
      return [
        {
          type: "source-url",
          sourceId: part.sourceId,
          url: part.url,
          ...(part.title != null ? { title: part.title } : {}),
        },
      ];
    case "source-document":
      return [
        {
          type: "source-document",
          sourceId: part.sourceId,
          mediaType: part.mediaType,
          title: part.title,
          ...(part.filename != null ? { filename: part.filename } : {}),
        },
      ];
    default:
      return [];
  }
}

function toolChunks(part: Extract<UIMessagePart, { toolCallId: string }>): UIMessageChunk[] {
  const dynamic = part.type === "dynamic-tool";
  const head = {
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    ...(dynamic ? { dynamic: true } : {}),
    ...(part.providerExecuted != null ? { providerExecuted: part.providerExecuted } : {}),
  };
  // `tool-input-start` alone leaves the part in `input-streaming`, which is
  // where a part with no input belongs.
  if (part.state === "input-streaming") return [{ type: "tool-input-start", ...head }];

  const chunks: UIMessageChunk[] = [{ type: "tool-input-available", ...head, input: part.input }];
  const approval = part.approval;
  if (approval != null) {
    chunks.push({
      type: "tool-approval-request",
      approvalId: approval.id,
      toolCallId: part.toolCallId,
      ...(approval.descriptor !== undefined ? { approvalDescriptor: approval.descriptor } : {}),
      ...(approval.requestReason != null ? { reason: approval.requestReason } : {}),
      ...(approval.isAutomatic === true ? { isAutomatic: true } : {}),
      ...(approval.signature != null ? { signature: approval.signature } : {}),
    });
    if (approval.approved != null) {
      chunks.push({
        type: "tool-approval-response",
        approvalId: approval.id,
        approved: approval.approved,
        ...(approval.reason != null ? { reason: approval.reason } : {}),
      });
    }
  }

  switch (part.state) {
    case "output-available":
      chunks.push({
        type: "tool-output-available",
        toolCallId: part.toolCallId,
        output: part.output,
        ...(dynamic ? { dynamic: true } : {}),
        ...(part.preliminary != null ? { preliminary: part.preliminary } : {}),
      });
      break;
    case "output-error":
      chunks.push({
        type: "tool-output-error",
        toolCallId: part.toolCallId,
        errorText: part.errorText,
        ...(dynamic ? { dynamic: true } : {}),
      });
      break;
    case "output-denied":
      chunks.push({ type: "tool-output-denied", toolCallId: part.toolCallId });
      break;
  }
  return chunks;
}
