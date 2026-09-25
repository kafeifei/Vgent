import { tool } from "ai";
import { z } from "zod";

/** Input schema for `updatePlan`: the whole todo list, replaced on every call. */
export const updatePlanInputSchema = z.object({
  goal: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  authorizations: z.array(z.string()).optional(),
  nextAction: z.string().optional(),
  replaceReason: z
    .string()
    .optional()
    .describe(
      "Only when the user explicitly replaced/cancelled the goal: cite the request. Otherwise omitted unfinished items are retained.",
    ),
  items: z.array(
    z.object({
      text: z.string(),
      evidence: z
        .array(z.string())
        .optional()
        .describe("Tool result or artifact references proving this item; old artifacts do not prove a new request ran."),
      status: z.enum(["pending", "in_progress", "done"]),
    }),
  ),
});

export type UpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

/**
 * Lets the model maintain a visible plan/todo list for the task. It has no
 * side effects of its own — the web UI's 计划 tab renders whatever this tool
 * was last called with, straight out of the message history.
 */
export const updatePlanTool = tool({
  description: "维护当前任务的计划/待办清单；每次调用整体替换",
  inputSchema: updatePlanInputSchema,
  execute: async ({ items }) => ({ ok: true, count: items.length }),
});

export interface TaskState extends UpdatePlanInput {
  updatedAt?: string;
}
export function createTaskPlan(initial?: TaskState, save?: (state: TaskState) => Promise<void>) {
  let state = initial;
  return {
    get: () => state,
    tool: tool({
      description: "保存复杂任务的计划与续接信息；简单任务无需调用。更新状态时保持条目名称不变，省略的未完成项仍保留。",
      inputSchema: updatePlanInputSchema,
      execute: async (input) => {
        const retained = input.replaceReason
          ? []
          : (state?.items ?? []).filter((item) => item.status !== "done" && !input.items.some((next) => next.text === item.text));
        const next = { ...state, ...input, items: [...input.items, ...retained], updatedAt: new Date().toISOString() };
        await save?.(next);
        state = next;
        return { ok: true, count: next.items.length, retained: retained.map((item) => item.text) };
      },
    }),
  };
}
