import { createCodexEngine } from "@vgent/engines";
import { describeSubscriptionAuth } from "@vgent/providers";
import type { TextStreamPart, ToolSet } from "ai";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/**
 * The real Codex engine, one harness session per thread.
 *
 * Resume strategy is the Claude Code one: the thread id *is* the harness
 * `sessionId`, a finished turn ends with `stop()` (runtime and sandbox down,
 * resume state persisted), and the next turn passes that state back as
 * `resumeFrom`.
 *
 * Unlike Claude Code, a Codex turn can never end unfinished: the adapter
 * reports `supportsBuiltinToolApprovals: false` and this engine passes no host
 * `tools`, so nothing can pause a turn waiting on the human. `hasUnfinishedTurn`
 * still reports what the session says rather than a hard `false`, so the run
 * manager keeps making the safe choice if that ever changes.
 */
export function createCodexEngineFactory(): EngineFactory {
  return {
    async ensureAvailable({ thread }) {
      // `HarnessAgent`'s constructor throws `HarnessCapabilityUnsupportedError`
      // for any other mode. Catching it here makes it a 400 with a readable
      // reason instead of an error part inside a 200 stream.
      if (thread.permissionMode !== "allow-all") {
        throw new BadRequestError("Codex 引擎没有内建工具审批，只支持 allow-all 权限模式", "codex_permission_mode");
      }
      // The adapter's `auth: 'auto'` reads the same store this reports on.
      const report = await describeSubscriptionAuth();
      if (!report.codex.available) {
        throw new EngineUnavailableError("Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）");
      }
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      const engine = await createCodexEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.thread.permissionMode,
        ...(ctx.thread.model != null ? { model: ctx.thread.model } : {}),
        sessionId: ctx.thread.id,
        // Codex turns never park, so a `continueFrom` can never be there to honour.
        ...(ctx.harnessState?.resumeFrom != null ? { resumeFrom: ctx.harnessState.resumeFrom } : {}),
      });

      let ended = false;

      return {
        hasUnfinishedTurn: () => engine.session.hasUnfinishedTurn(),

        async stream({ messages, abortSignal }) {
          // The whole converted history goes in on purpose; the harness session
          // owns its own native history and collapses the array to its last
          // `role: 'user'` message.
          // `options: undefined` is required by the call-options generic; this agent has no `callOptionsSchema`.
          const result = await engine.harnessAgent.stream({ session: engine.session, messages, abortSignal, options: undefined });
          return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
        },

        async destroy() {
          if (ended) return;
          ended = true;
          await engine.dispose().catch((error) => ctx.log.warn(`销毁 Codex session 失败 (thread ${ctx.thread.id})`, error));
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
            ctx.log.warn(`保存 Codex resume 状态失败 (thread ${ctx.thread.id})`, error);
            await engine.dispose().catch(() => {});
          }
        },
      };
    },
  };
}
