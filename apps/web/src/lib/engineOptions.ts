import type { EngineId, PermissionMode } from "./types";

/**
 * The one list of engines and their Chinese labels. `TaskHeader`, `EmptyState`
 * and `SettingsView` all pick from this instead of keeping their own copies.
 */
export const ENGINES: ReadonlyArray<{ id: EngineId; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "vgent", label: "Vgent（自研）" },
];

/** The one list of permission modes, in the order every picker shows them. */
export const PERMISSIONS: readonly PermissionMode[] = ["allow-reads", "allow-edits", "allow-all"];
