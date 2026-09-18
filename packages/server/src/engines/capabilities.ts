import type { EngineId, PermissionMode, Settings } from "../types.js";

/**
 * 引擎能力表, one row. What the UI shows per engine is decided here and served
 * over `GET /api/engines`, so no client ever has to branch on an engine's name.
 *
 * Every field is a plain boolean on purpose: a capability is either there or it
 * is not, and「明说，不装」means a missing one turns into a sentence, never into
 * a control that cannot be used.
 */
export interface EngineCapabilities {
  /** Can ask the human before running a tool. Without it the engine only ever runs 全自动. */
  approvals: boolean;
  /** Has an `askUserQuestions` tool. */
  askUser: boolean;
  /** Can run a read-only Plan turn. */
  planMode: boolean;
  /** Can have its history replaced by a summary (`POST /threads/:id/compact`). */
  compact: boolean;
  /** We know which model it falls back to; otherwise only the harness does. */
  knownDefaultModel: boolean;
  /** MCP servers, skills and memory. */
  extensions: boolean;
  /**
   * Can be pointed at a provider from the settings page (its own endpoint and
   * key). Codex cannot: its harness only ever runs on the machine's Codex login.
   */
  customProviders: boolean;
}

/** One engine as the client sees it: an id, a name to show, and the row above. */
export interface EngineDescriptor {
  id: EngineId;
  label: string;
  capabilities: EngineCapabilities;
}

/**
 * The permission a turn really runs under. 运行模式 and its allowlist are global
 * settings; an engine that cannot ask is pinned to 全自动 rather than being
 * handed a mode it would refuse to start in.
 */
export function effectivePermission(
  capabilities: EngineCapabilities,
  settings: Settings,
): { permissionMode: PermissionMode; alwaysAllow: string[] } {
  return {
    permissionMode: capabilities.approvals ? settings.runMode : "allow-all",
    alwaysAllow: settings.allowlist,
  };
}
