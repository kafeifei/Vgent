import { createClaudeCodeEngine } from "@vgent/engines";
import type { TextStreamPart, ToolSet } from "ai";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/**
 * The real Claude Code engine, one harness session per thread.
 *
 * Resume strategy: the thread id *is* the harness `sessionId`, a turn that runs
 * to completion ends with `stop()` (runtime and sandbox down, resume state
 * persisted), and the next turn passes that state back as `resumeFrom`.
 *
 * A turn that ends *unfinished* (awaiting approval / a client tool result) must
 * not be stopped: `session.stop()` then returns a continuation payload carrying
 * the live bridge's port and token, and kills that bridge on the way out, so
 * the next `createSession({ resumeFrom })` hangs forever on a dead port. The
 * run manager parks such a runner instead and calls `stream()` on this same
 * session again. `session.detach()` would let an unfinished turn survive a
 * restart; that is future work.
 */
export function createClaudeCodeEngineFactory(): EngineFactory {
  return {
    async create(ctx: EngineContext): Promise<EngineRunner> {
      const engine = await createClaudeCodeEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.thread.permissionMode,
        ...(ctx.thread.model != null ? { model: ctx.thread.model } : {}),
        sessionId: ctx.thread.id,
        ...(ctx.harnessState != null ? { resumeFrom: ctx.harnessState.resumeFrom } : {}),
      });

      let ended = false;

      return {
        hasUnfinishedTurn: () => engine.session.hasUnfinishedTurn(),

        async stream({ messages, abortSignal }) {
          // The whole converted history goes in on purpose. The harness session
          // owns its own native history and collapses the array to its last
          // `role: 'user'` message, but an approval continuation needs the
          // matching `tool-approval-request` from the prior assistant message
          // to still be in the array to resolve its approval id.
          // `options: undefined` is required by the call-options generic; this agent has no `callOptionsSchema`.
          const result = await engine.harnessAgent.stream({ session: engine.session, messages, abortSignal, options: undefined });
          return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
        },

        async destroy() {
          if (ended) return;
          ended = true;
          await engine.dispose().catch((error) => ctx.log.warn(`销毁 harness session 失败 (thread ${ctx.thread.id})`, error));
        },

        async finish() {
          if (ended) return;
          ended = true;
          try {
            const resumeFrom = await engine.stop();
            await ctx.saveHarnessState({
              version: 1,
              sessionId: ctx.thread.id,
              resumeFrom,
              updatedAt: new Date().toISOString(),
            });
          } catch (error) {
            ctx.log.warn(`保存 harness resume 状态失败 (thread ${ctx.thread.id})`, error);
            await engine.dispose().catch(() => {});
          }
        },
      };
    },
  };
}
