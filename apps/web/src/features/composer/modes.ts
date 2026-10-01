import type { ThreadMode } from "@/lib/types";
import type { SlashCommand } from "./slash";

/** 模式: what the next message does. One line each, because that is the whole choice. */
export const MODES: ReadonlyArray<{ id: ThreadMode; label: string; hint: string }> = [
  { id: "agent", label: "Agent", hint: "直接动手" },
  { id: "plan", label: "Plan", hint: "先只读调研、出计划，你改完再 Build" },
];

/**
 * The 模式 rows of the `/` menu. Only the ones that can be entered are there:
 * Plan is left out on an engine that cannot be held to read-only, and while a
 * turn runs nothing but the mode already in force is — a row that could not be
 * used would be listed dead, and with a sentence saying why, which is what
 * this menu does not do.
 */
export function modeRows(options: {
  mode: ThreadMode;
  planSupported: boolean;
  /** False while a turn runs: the mode cannot change then. */
  canLeaveMode: boolean;
  onPick: (mode: ThreadMode) => void;
}): SlashCommand[] {
  const { mode, planSupported, canLeaveMode, onPick } = options;
  return MODES.filter((entry) => (entry.id !== "plan" || planSupported) && (canLeaveMode || entry.id === mode)).map((entry) => ({
    id: entry.id,
    label: entry.label,
    section: "模式",
    selected: entry.id === mode,
    run: () => onPick(entry.id),
  }));
}
