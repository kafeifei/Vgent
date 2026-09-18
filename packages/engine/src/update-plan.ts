import { tool } from "ai";
import { z } from "zod";

/** Input schema for `updatePlan`: the whole todo list, replaced on every call. */
export const updatePlanInputSchema = z.object({
  items: z.array(
    z.object({
      text: z.string(),
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
