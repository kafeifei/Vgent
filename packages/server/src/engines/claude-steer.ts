import type { TextStreamPart, ToolSet } from "ai";

/** The patched Claude bridge preserves the caller's id and forwards SDK lifecycle events. */
export function trackClaudeSteers(
  stream: ReadableStream<TextStreamPart<ToolSet>>,
  applied: (messageId: string) => Promise<void>,
): ReadableStream<TextStreamPart<ToolSet>> {
  return stream.pipeThrough(new TransformStream({
    async transform(part, controller) {
      if (part.type === "raw" && typeof part.rawValue === "object" && part.rawValue !== null) {
        const event = part.rawValue as { type?: unknown; messageId?: unknown; state?: unknown };
        if (event.type === "vgent-steer-lifecycle") {
          if (typeof event.messageId === "string" && (event.state === "started" || event.state === "completed"))
            await applied(event.messageId);
          return;
        }
      }
      controller.enqueue(part);
    },
  }));
}
