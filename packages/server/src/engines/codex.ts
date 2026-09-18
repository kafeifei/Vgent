import { createCodexEngine, type CodexEngineOptions } from "@vgent/engines";
import { describeSubscriptionAuth } from "@vgent/providers";
import type { TextStreamPart, ToolSet } from "ai";
import { EngineUnavailableError } from "../errors.js";
import type { EngineDescriptor } from "./capabilities.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/**
 * 引擎能力表, the Codex row. `update_plan` exists but produces no UI part, and
 * the harness has no built-in tool approval at all — so every Codex turn runs
 * 全自动, which `effectivePermission` is what decides.
 */
const DESCRIPTOR: EngineDescriptor = {
  id: "codex",
  label: "Codex",
  capabilities: {
    approvals: false,
    askUser: false,
    planMode: false,
    compact: false,
    knownDefaultModel: false,
    extensions: false,
  },
};

/**
 * The Codex harness takes a `reasoningEffort` of its own
 * (`CodexHarnessSettings.reasoningEffort`), but only these five values; the
 * catalog can list others (a model row may offer `none`, say), so a level the
 * CLI would reject is dropped rather than passed on.
 */
const CODEX_EFFORTS: ReadonlyArray<NonNullable<CodexEngineOptions["reasoningEffort"]>> = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function asCodexEffort(level: string | undefined): CodexEngineOptions["reasoningEffort"] | undefined {
  return CODEX_EFFORTS.find((effort) => effort === level);
}

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
    descriptor: DESCRIPTOR,

    async ensureAvailable() {
      // The adapter's `auth: 'auto'` reads the same store this reports on.
      const report = await describeSubscriptionAuth();
      if (!report.codex.available) {
        throw new EngineUnavailableError("Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）");
      }
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      const reasoningEffort = asCodexEffort(ctx.thread.reasoningEffort);
      const engine = await createCodexEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.permissionMode,
        ...(ctx.thread.model != null ? { model: ctx.thread.model } : {}),
        ...(reasoningEffort != null ? { reasoningEffort } : {}),
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
