import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import type { EngineId, HarnessState, Logger, PermissionMode, Project, ThreadRecord } from "../types.js";
import type { EngineDescriptor } from "./capabilities.js";
import { createClaudeCodeEngineFactory } from "./claude-code.js";
import { createCodexEngineFactory } from "./codex.js";
import { createVgentEngineFactory } from "./vgent.js";

/**
 * One engine instance bound to one thread. It normally lives for exactly one
 * turn, but a turn that ends waiting on the human (approval / tool result) is
 * *parked*: the runner stays alive between HTTP requests, because its resume
 * state would point at a bridge `finish()` has already killed.
 */
export interface EngineRunner {
  stream(input: { messages: ModelMessage[]; abortSignal: AbortSignal }): Promise<{ stream: ReadableStream<TextStreamPart<ToolSet>> }>;
  /**
   * The tool set this runner's messages have to be converted with, when it has
   * one. `toModelOutput` — how a subagent tool hands the model a summary
   * instead of its whole transcript — is applied by `convertToModelMessages`,
   * and only when it is given the very tools the engine runs with. The harness
   * engines run their tools out of process and leave this undefined.
   */
  tools?: ToolSet;
  /** End the turn: stop the runtime and persist whatever resume state it hands back. */
  finish(): Promise<void>;
  /**
   * Freeze the unfinished turn instead of tearing it down, and hand back the
   * state that reattaches to it. The runtime, its bridge and its sandbox stay
   * up — that is the whole point, and why this is only ever called on a
   * *graceful* shutdown. The caller persists the returned state; this runner is
   * dead afterwards (`finish()` / `destroy()` become no-ops).
   *
   * Only a stateful engine whose runtime can outlive this process implements
   * it. Absent, or rejected, means the parked turn has to be interrupted.
   */
  suspend?(): Promise<HarnessState>;
  /** Tear the runtime down and discard resumability. Never persists state. */
  destroy(): Promise<void>;
  /**
   * True while the runtime still holds an unfinished turn (pending approval or
   * tool result). `finish()` is only safe when this is false: the harness's
   * `stop()` answers an unfinished turn with a *continuation* payload that
   * points at the very bridge the same call then kills.
   */
  hasUnfinishedTurn(): boolean;
}

export interface EngineContext {
  thread: ThreadRecord;
  project: Project;
  /**
   * The project's *own* checkout. `project.repoPath` is the thread's working
   * directory, which for a worktree task is the worktree — so this is the only
   * way back to the repository it was cut from.
   */
  projectPath: string;
  dataDir: string;
  /**
   * The mode this turn runs under, resolved from the global 运行模式 against
   * this engine's capabilities at turn start. Engines read it from here rather
   * than from the thread: the setting is global, and a thread that was created
   * under another mode must not keep running under it.
   */
  permissionMode: PermissionMode;
  /** The global「一直允许」list, same resolution. Empty means nothing is pre-allowed. */
  alwaysAllow: string[];
  /**
   * True when this is a 计划 turn (`thread.mode === "plan"`). The factory has to
   * *enforce* it: run with a tool set that cannot write, and add the Plan
   * addendum to the prompt. Only an engine whose `capabilities.planMode` is true
   * ever sees it — the routes refuse the mode otherwise.
   */
  planMode: boolean;
  harnessState?: HarnessState;
  /**
   * True when this turn continues the open one (the converted history ends in a
   * `role: 'tool'` message: an approval answer or a client tool result). Only
   * then may a runner attach to a persisted `continueFrom` — a fresh prompt
   * abandons that turn and has to start from the last finished state instead.
   */
  continuesTurn: boolean;
  /** Where `finish()` writes the resume state. Injected so the factory never reaches for the store. */
  saveHarnessState(state: HarnessState): Promise<void>;
  log: Logger;
}

export interface EngineFactory {
  /**
   * What this engine is called and what it can do — the single source of the
   * 引擎能力表 `GET /api/engines` serves and every client branches on.
   */
  descriptor: EngineDescriptor;
  /**
   * Cheap precondition checked before the run starts, so "this engine cannot
   * run here" is an HTTP error. Everything that needs the sandbox belongs in
   * `create`, where failures reach the client as stream error parts instead.
   */
  ensureAvailable?(ctx: { thread: ThreadRecord }): void | Promise<void>;
  /**
   * True when a turn leaves nothing behind in the runner: the whole
   * conversation, including a pending approval, is reconstructible from the
   * stored messages. Such a thread may stay `awaiting-approval` across a
   * restart — the next turn just builds a fresh runner from the history — while
   * a stateful engine's pending approval dies with its bridge and has to be
   * closed.
   */
  statelessTurns?: boolean;
  create(ctx: EngineContext): Promise<EngineRunner>;
}

export type EngineRegistry = Record<EngineId, EngineFactory>;

/** Engine ids whose turns hold no live state; see `EngineFactory.statelessTurns`. */
export function statelessEngines(registry: EngineRegistry): ReadonlySet<EngineId> {
  const ids = new Set<EngineId>();
  for (const [id, factory] of Object.entries(registry) as [EngineId, EngineFactory][]) {
    if (factory.statelessTurns === true) ids.add(id);
  }
  return ids;
}

/** The engine ids this registry serves, in declaration order. */
export function engineIds(registry: EngineRegistry): EngineId[] {
  return Object.keys(registry) as EngineId[];
}

/** The 引擎能力表 as served by `GET /api/engines`. */
export function engineDescriptors(registry: EngineRegistry): EngineDescriptor[] {
  return engineIds(registry).map((id) => registry[id].descriptor);
}

/**
 * A replacement engine in a test registry. Its descriptor is optional: a stand-in
 * for, say, Claude Code is exercised through Claude Code's own capabilities, and
 * making every test restate the table would be a second source for it.
 */
export type EngineFactoryOverride = Omit<EngineFactory, "descriptor"> & { descriptor?: EngineDescriptor };

/** All three engines, each backed by its real runtime. */
export function createEngineRegistry(overrides?: Partial<Record<EngineId, EngineFactoryOverride>>): EngineRegistry {
  const base: EngineRegistry = {
    "claude-code": createClaudeCodeEngineFactory(),
    codex: createCodexEngineFactory(),
    vgent: createVgentEngineFactory(),
  };
  if (overrides == null) return base;
  for (const id of engineIds(base)) {
    const override = overrides[id];
    if (override != null) base[id] = { ...override, descriptor: override.descriptor ?? base[id].descriptor };
  }
  return base;
}
