import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { latestPlan, planItemsOf } from "./plan";

type Part = UIMessage["parts"][number];
const part = (type: string, rest: Record<string, unknown>): Part => ({ type, toolCallId: "c1", ...rest }) as unknown as Part;
const msg = (parts: Part[]): UIMessage => ({ id: "m1", role: "assistant", parts });

describe("latestPlan", () => {
  it("normalises vgent's updatePlan shape", () => {
    const messages = [
      msg([
        part("tool-updatePlan", {
          state: "output-available",
          input: {
            items: [
              { text: "读代码", status: "done" },
              { text: "写测试", status: "in_progress" },
            ],
          },
        }),
      ]),
    ];
    expect(latestPlan(messages)).toEqual([
      { text: "读代码", status: "done" },
      { text: "写测试", status: "in_progress" },
    ]);
  });

  it("normalises Claude Code's TodoWrite shape, mapping completed to done", () => {
    const messages = [
      msg([
        part("tool-TodoWrite", {
          state: "input-available",
          input: {
            todos: [
              { content: "探索代码库", status: "completed", activeForm: "探索代码库中" },
              { content: "实现功能", status: "pending", activeForm: "实现功能中" },
            ],
          },
        }),
      ]),
    ];
    expect(latestPlan(messages)).toEqual([
      { text: "探索代码库", status: "done" },
      { text: "实现功能", status: "pending" },
    ]);
  });

  it("normalises Codex's update_plan shape", () => {
    const messages = [
      msg([
        part("tool-update_plan", {
          state: "output-available",
          input: {
            plan: [{ step: "跑测试", status: "in_progress" }],
            explanation: "验证改动",
          },
        }),
      ]),
    ];
    expect(latestPlan(messages)).toEqual([{ text: "跑测试", status: "in_progress" }]);
  });

  it("also handles a dynamic-tool update_plan", () => {
    const messages = [
      msg([
        part("dynamic-tool", {
          toolName: "update_plan",
          state: "output-available",
          input: { plan: [{ step: "a", status: "pending" }] },
        }),
      ]),
    ];
    expect(latestPlan(messages)).toEqual([{ text: "a", status: "pending" }]);
  });

  it("takes the last plan call, ignores a still-streaming one, and returns null with none", () => {
    expect(latestPlan([])).toBeNull();

    const messages = [
      msg([part("tool-updatePlan", { state: "output-available", input: { items: [{ text: "old", status: "done" }] } })]),
      msg([part("tool-updatePlan", { state: "output-available", input: { items: [{ text: "new", status: "pending" }] } })]),
      msg([part("tool-updatePlan", { state: "input-streaming", input: { items: [{ text: "new", status: "pending" }] } })]),
    ];
    expect(latestPlan(messages)).toEqual([{ text: "new", status: "pending" }]);
  });
});

describe("planItemsOf", () => {
  it("reads one plan call, and nothing from a streaming one or another tool", () => {
    const input = { items: [{ text: "读代码", status: "pending" }] };
    expect(planItemsOf(part("tool-updatePlan", { state: "input-available", input }))).toEqual([{ text: "读代码", status: "pending" }]);
    expect(planItemsOf(part("tool-updatePlan", { state: "input-streaming", input }))).toBeNull();
    expect(planItemsOf(part("tool-read", { state: "output-available", input: { file_path: "a.ts" } }))).toBeNull();
    expect(planItemsOf({ type: "text", text: "计划" })).toBeNull();
  });
});
