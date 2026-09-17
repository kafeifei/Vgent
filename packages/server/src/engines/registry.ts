import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { NotImplementedError } from "../errors.js";
import type { EngineId, HarnessState, Logger, Project, ThreadRecord } from "../types.js";
import { createClaudeCodeEngineFactory } from "./claude-code.js";

/**
 * One engine instance bound to one thread. It normally lives for exactly one
 * turn, but a turn that ends waiting on the human (approval / tool result) is
 * *parked*: the runner stays alive between HTTP requests, because its resume
 * state would point at a bridge `finish()` has already killed.
 */
export interface EngineRunner {
  stream(input: { messages: ModelMessage[]; abortSignal: AbortSignal }): Promise<{ stream: ReadableStream<TextStreamPart<ToolSet>> }>;
  /** End the turn: stop the runtime and persist whatever resume state it hands back. */
  finish(): Promise<void>;
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
  dataDir: string;
  harnessState?: HarnessState;
  /** Where `finish()` writes the resume state. Injected so the factory never reaches for the store. */
  saveHarnessState(state: HarnessState): Promise<void>;
  log: Logger;
}

export interface EngineFactory {
  /**
   * Cheap precondition checked before the run starts, so "this engine does not
   * exist" is an HTTP error. Everything that needs the sandbox belongs in
   * `create`, where failures reach the client as stream error parts instead.
   */
  ensureAvailable?(): void;
  create(ctx: EngineContext): Promise<EngineRunner>;
}

export type EngineRegistry = Record<EngineId, EngineFactory>;

function notWired(engine: EngineId): EngineFactory {
  const fail = (): never => {
    throw new NotImplementedError(`引擎尚未接线: ${engine}`, "engine_not_implemented");
  };
  return { ensureAvailable: fail, create: fail };
}

/**
 * Only the Claude Code engine is wired. Codex and the in-house engine keep a
 * slot so the shape of the registry does not change when they land; asking for
 * one is a typed 501, not a crash.
 */
export function createEngineRegistry(overrides?: Partial<EngineRegistry>): EngineRegistry {
  return {
    "claude-code": createClaudeCodeEngineFactory(),
    codex: notWired("codex"),
    vgent: notWired("vgent"),
    ...overrides,
  };
}
