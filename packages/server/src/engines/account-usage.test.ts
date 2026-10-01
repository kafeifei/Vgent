import { expect, it, vi } from "vitest";
import type { TextStreamPart, ToolSet } from "ai";
import { trackClaudeUsage } from "./account-usage.js";

it("captures conversation quotas, strips raw account events and never waits for quota persistence", async () => {
  const report = vi.fn(() => new Promise<void>(() => {}));
  const input = new ReadableStream<TextStreamPart<ToolSet>>({ start(controller) {
    controller.enqueue({ type: "raw", rawValue: { type: "vgent-account-usage", info: { unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 2_000_000_000 } } } } });
    controller.enqueue({ type: "text-delta", id: "reply", text: "ok" });
    controller.close();
  } });
  const reader = trackClaudeUsage(input, report).getReader();
  expect((await reader.read()).value).toEqual({ type: "text-delta", id: "reply", text: "ok" });
  expect((await reader.read()).done).toBe(true);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ windows: [expect.objectContaining({ usedPercent: 37 })] }));
});
