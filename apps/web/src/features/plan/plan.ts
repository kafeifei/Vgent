import { getToolName, isToolUIPart, type UIMessage } from "ai";

export type PlanStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

function normalizeStatus(status: unknown): PlanStatus {
  if (status === "in_progress") return "in_progress";
  if (status === "done" || status === "completed") return "done";
  return "pending";
}

/**
 * The three shapes a plan tool's input takes, normalised to `PlanItem[]`.
 * Vgent's own `updatePlan` (`items`), Claude Code's `TodoWrite` (`todos`,
 * `content`), Codex's `update_plan` (`plan`, `step`). `null` when `input`
 * does not look like any of them.
 */
function normalizePlanInput(name: string, input: unknown): PlanItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;

  if (name === "updateplan" && Array.isArray(record.items)) {
    return record.items.map((item) => {
      const entry = item as Record<string, unknown>;
      return { text: String(entry.text ?? ""), status: normalizeStatus(entry.status) };
    });
  }
  if (name === "todowrite" && Array.isArray(record.todos)) {
    return record.todos.map((item) => {
      const entry = item as Record<string, unknown>;
      return { text: String(entry.content ?? ""), status: normalizeStatus(entry.status) };
    });
  }
  if (name === "update_plan" && Array.isArray(record.plan)) {
    return record.plan.map((item) => {
      const entry = item as Record<string, unknown>;
      return { text: String(entry.step ?? ""), status: normalizeStatus(entry.status) };
    });
  }
  return null;
}

/** The list one plan call carries, once its input has fully arrived; `null` for any other call. */
export function planItemsOf(part: UIMessage["parts"][number]): PlanItem[] | null {
  if (!isToolUIPart(part) || part.state === "input-streaming") return null;
  return normalizePlanInput(getToolName(part).toLowerCase(), part.input);
}

/**
 * The agent's current plan: the last plan tool call in the conversation whose
 * input has fully arrived (anything but `input-streaming`), from whichever of
 * the three engines produced it. `null` when nothing has set a plan yet.
 */
export function latestPlan(messages: readonly UIMessage[]): PlanItem[] | null {
  let latest: PlanItem[] | null = null;
  for (const message of messages) {
    for (const part of message.parts) {
      const items = planItemsOf(part);
      if (items != null) latest = items;
    }
  }
  return latest;
}
