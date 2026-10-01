import type { TextStreamPart, ToolSet } from "ai";
import type { AccountUsage } from "../accounts/types.js";
import { object, parseClaudeRateLimit } from "../accounts/usage.js";

/** Consume only the quota event; no raw account metadata goes into chat history. */
export function trackClaudeUsage(stream: ReadableStream<TextStreamPart<ToolSet>>, report?: (usage: AccountUsage) => Promise<void>): ReadableStream<TextStreamPart<ToolSet>> {
  return stream.pipeThrough(new TransformStream({
    transform(part, controller) {
      if (part.type === "raw" && object(part.rawValue).type === "vgent-account-usage") {
        const usage = parseClaudeRateLimit(object(part.rawValue).info);
        if (usage && report) void report(usage).catch(() => {});
        return;
      }
      controller.enqueue(part);
    },
  }));
}
