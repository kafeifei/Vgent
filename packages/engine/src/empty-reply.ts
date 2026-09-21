import type { LanguageModelMiddleware } from "ai";

type DoStream = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["doStream"];
type StreamPart = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer Part> ? Part : never;

/** How many times a call that came back with nothing is made again. */
export const EMPTY_REPLY_RETRIES = 2;

/** Finish reasons where asking again is pointless: the answer was cut or refused, not missing. */
const FINAL_REASONS = new Set(["length", "content-filter", "error"]);

const reasonOf = (part: StreamPart): string | undefined => {
  if (part.type !== "finish") return undefined;
  const reason = part.finishReason as unknown;
  if (typeof reason === "string") return reason;
  return typeof reason === "object" && reason !== null ? String((reason as { unified?: unknown }).unified) : undefined;
};

/**
 * Some gateways now and then finish a call having said nothing: a lone space,
 * no tool call, one output token. The loop reads that as "the agent is done",
 * and the user is left looking at their own message. This asks again instead.
 *
 * Text is held back until it has a visible character in it, so a call that is
 * thrown away leaves nothing behind in the stream; everything else — reasoning,
 * tool calls — goes straight through, and counts as the model having answered.
 */
export function retryEmptyReply(retries = EMPTY_REPLY_RETRIES): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream }) => {
      const first = await doStream();
      let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
      const stream = new ReadableStream<StreamPart>({
        async start(controller) {
          try {
            let current = first.stream;
            for (let attempt = 0; ; attempt += 1) {
              let answered = false;
              let again = false;
              let held: StreamPart[] = [];
              reader = current.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.type === "stream-start" && attempt > 0) continue;
                if (value.type === "text-start" || value.type === "text-delta" || value.type === "text-end") {
                  if (value.type === "text-delta" && value.delta.trim() !== "") answered = true;
                  if (!answered) {
                    held.push(value);
                    continue;
                  }
                } else if (value.type === "finish") {
                  if (!answered && attempt < retries && !FINAL_REASONS.has(reasonOf(value) ?? "")) {
                    again = true;
                    continue;
                  }
                } else if (value.type !== "stream-start" && value.type !== "response-metadata" && !value.type.startsWith("reasoning")) {
                  answered = true;
                }
                for (const part of held) controller.enqueue(part);
                held = [];
                controller.enqueue(value);
              }
              if (!again) break;
              current = (await doStream()).stream;
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel: (reason) => reader?.cancel(reason),
      });
      return { ...first, stream };
    },
  };
}
