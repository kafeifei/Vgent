import type { UIMessageChunk } from "ai";

/**
 * One append-only chunk buffer per assistant turn, plus its live subscribers.
 *
 * Replay and live tail are the same code path: a subscriber pumps from index 0
 * and keeps pumping as new chunks arrive, so a page refreshed mid-turn
 * reconstructs exactly the message the server persists from the same chunks.
 *
 * One exception keeps a long turn's memory bounded: a preliminary tool output
 * is the tool's whole result so far (a subagent's transcript), and the next
 * output for the same call replaces it outright. Only the latest one stays in
 * the buffer; the earlier ones become holes the pump steps over. Subscribers
 * pump only as fast as they read, so a slow page skips those too instead of
 * queueing every copy.
 */
export interface ChunkHub {
  readonly closed: boolean;
  /** The buffer so far, without superseded preliminary outputs. Tests read it. */
  readonly chunks: readonly UIMessageChunk[];
  publish(chunk: UIMessageChunk): void;
  /** Close every part left open by a stopped or failed turn, as chunks. */
  interrupt(errorText: string): void;
  close(): void;
  subscribe(signal?: AbortSignal): ReadableStream<UIMessageChunk>;
}

const TERMINAL_TOOL_STATES = new Set(["output-available", "output-error", "output-denied"]);

export function createChunkHub(): ChunkHub {
  const buffer: (UIMessageChunk | undefined)[] = [];
  /** Where each tool call's latest preliminary output sits in `buffer`. */
  const preliminaryAt = new Map<string, number>();
  const subscribers = new Set<() => void>();
  const toolStates = new Map<string, string>();
  const openText = new Set<string>();
  const openReasoning = new Set<string>();
  let closed = false;

  const track = (chunk: UIMessageChunk) => {
    switch (chunk.type) {
      case "text-start":
        openText.add(chunk.id);
        break;
      case "text-end":
        openText.delete(chunk.id);
        break;
      case "reasoning-start":
        openReasoning.add(chunk.id);
        break;
      case "reasoning-end":
        openReasoning.delete(chunk.id);
        break;
      case "tool-input-start":
      case "tool-input-available":
        toolStates.set(chunk.toolCallId, "input-available");
        break;
      case "tool-approval-request":
        toolStates.set(chunk.toolCallId, "approval-requested");
        break;
      case "tool-output-available":
        toolStates.set(chunk.toolCallId, "output-available");
        break;
      case "tool-output-error":
        toolStates.set(chunk.toolCallId, "output-error");
        break;
      case "tool-output-denied":
        toolStates.set(chunk.toolCallId, "output-denied");
        break;
    }
  };

  const wake = () => {
    for (const notify of [...subscribers]) notify();
  };

  const hub: ChunkHub = {
    get closed() {
      return closed;
    },
    get chunks() {
      return buffer.filter((chunk) => chunk !== undefined);
    },

    publish(chunk) {
      if (closed) return;
      track(chunk);
      if (chunk.type === "tool-output-available") {
        const earlier = preliminaryAt.get(chunk.toolCallId);
        if (earlier !== undefined) buffer[earlier] = undefined;
        if (chunk.preliminary === true) preliminaryAt.set(chunk.toolCallId, buffer.length);
        else preliminaryAt.delete(chunk.toolCallId);
      }
      buffer.push(chunk);
      wake();
    },

    interrupt(errorText) {
      for (const [toolCallId, state] of toolStates) {
        if (!TERMINAL_TOOL_STATES.has(state)) hub.publish({ type: "tool-output-error", toolCallId, errorText });
      }
      for (const id of [...openText]) hub.publish({ type: "text-end", id });
      for (const id of [...openReasoning]) hub.publish({ type: "reasoning-end", id });
    },

    close() {
      if (closed) return;
      closed = true;
      wake();
    },

    subscribe(signal) {
      let index = 0;
      let controller: ReadableStreamDefaultController<UIMessageChunk> | undefined;
      let notify = () => {};
      let done = false;

      const stop = () => {
        if (done) return;
        done = true;
        subscribers.delete(notify);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        stop();
        try {
          controller?.close();
        } catch {
          // already cancelled
        }
      };
      const pump = () => {
        if (done || controller == null) return;
        // `pull` resumes a subscriber that stopped here for want of room.
        while (index < buffer.length && (controller.desiredSize ?? 1) > 0) {
          const chunk = buffer[index++];
          if (chunk === undefined) continue;
          try {
            controller.enqueue(chunk);
          } catch {
            stop();
            return;
          }
        }
        if (closed && index >= buffer.length) {
          stop();
          try {
            controller.close();
          } catch {
            // already cancelled
          }
        }
      };

      return new ReadableStream<UIMessageChunk>({
        start(streamController) {
          controller = streamController;
          notify = pump;
          subscribers.add(notify);
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted === true) onAbort();
          else pump();
        },
        pull() {
          pump();
        },
        cancel() {
          stop();
        },
      });
    },
  };

  return hub;
}
