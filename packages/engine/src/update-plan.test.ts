import { describe, expect, it } from "vitest";
import { updatePlanTool } from "./update-plan.js";

// Minimal fixture for ToolExecutionOptions; execute below never reads it.
const execOptions = { toolCallId: "t1", messages: [] } as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("updatePlanTool", () => {
  it("reports the item count and has no other side effect", async () => {
    const result = await updatePlanTool.execute!(
      {
        items: [
          { text: "读懂需求", status: "done" },
          { text: "写实现", status: "in_progress" },
          { text: "跑测试", status: "pending" },
        ],
      },
      execOptions,
    );
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("handles an empty plan", async () => {
    const result = await updatePlanTool.execute!({ items: [] }, execOptions);
    expect(result).toEqual({ ok: true, count: 0 });
  });
});
