import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("the shipped Claude bridge forwards native subscription windows without unrelated account fields", async () => {
  const require = createRequire(import.meta.url);
  const source = await readFile(join(dirname(require.resolve("@ai-sdk/harness-claude-code")), "bridge/index.mjs"), "utf8");
  const start = source.indexOf('if (type === "rate_limit_event")');
  const end = source.indexOf('if (type === "command_lifecycle")', start);
  if (start < 0 || end < start) throw new Error("Claude bridge quota forwarding block is missing");
  // Execute the installed bootstrap's event branch, not a copy of its implementation.
  const run = new Function("messages", "emit", `for (const msg of messages) { const type = msg.type; ${source.slice(start, end)} }`);
  const windows = { five_hour: { utilization: 0, resetsAt: 2_000_000_000 }, seven_day: { utilization: 0.65, resetsAt: 2_000_000_001 } };
  const events: unknown[] = [];
  run([{ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: windows, privateField: "must-not-leave-runtime" } }, { type: "rate_limit_event" }, { type: "assistant" }], (event: unknown) => events.push(event));
  expect(events).toEqual([{ type: "raw", rawValue: { type: "vgent-account-usage", info: { status: "allowed", utilization: undefined, resetsAt: undefined, rateLimitType: undefined, unifiedWindows: windows } } }]);
  expect(JSON.stringify(events)).not.toContain("must-not-leave-runtime");
});
