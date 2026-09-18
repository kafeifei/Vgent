import { collectHarnessAgentToolApprovalContinuations, collectHarnessAgentToolResultContinuations } from "@ai-sdk/harness/agent";
import { planModeInstructions } from "@vgent/engine";
import { claudeCodeProviderEnv, claudeCodeThinking, createClaudeCodeEngine } from "@vgent/engines";
import { splitProviderModelSpec, type ProviderConfig } from "@vgent/providers";
import type { TextStreamPart, ToolSet } from "ai";
import { BadRequestError, TurnResumeFailedError } from "../errors.js";
import { createProviderStore } from "../store/providers.js";
import type { EngineDescriptor } from "./capabilities.js";
import { stripDeniedApprovalResults } from "./harness-messages.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/** 引擎能力表, the Claude Code row: it can ask, and it can plan; the rest is not wired. */
const DESCRIPTOR: EngineDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  capabilities: {
    approvals: true,
    askUser: false,
    planMode: true,
    compact: false,
    knownDefaultModel: false,
    extensions: false,
    customProviders: true,
  },
};

/**
 * The tools a 计划 turn leaves active, by their harness names. Everything else
 * — `write`, `edit`, `bash`, `Agent`, the Task tools, MCP — is excluded, which
 * the adapter enforces twice: the complement goes to the CLI as
 * `disallowedTools`, and the bridge's permission layer refuses an inactive tool
 * outright. `TodoWrite` stays because it only drives the 计划 tab's todo list.
 */
const PLAN_ACTIVE_TOOLS = ["read", "grep", "glob", "TodoWrite"] as const;

/** Claude Code has no `askUserQuestions`, so the addendum tells it to ask in prose. */
const PLAN_INSTRUCTIONS = planModeInstructions({ askTool: false });

/**
 * A thread model of the form `<providerId>:<model>` runs on that provider's
 * Anthropic-compatible endpoint instead of the machine's Claude login: the
 * engine is handed the endpoint and key as its authentication, the bare model
 * id, and the CLI environment that keeps every request on that model.
 *
 * Anything else — `sonnet`, a full Anthropic id, nothing — is the runtime's own
 * business and yields `undefined`. A prefix that names a provider which has no
 * `claude-code` endpoint (or no longer exists) is refused rather than sent to
 * Anthropic as a model id it would 404 on.
 */
export function providerRoute(model: string | undefined, providers: readonly ProviderConfig[]) {
  if (model == null) return undefined;
  const split = splitProviderModelSpec(model);
  if (split == null) return undefined;
  const provider = providers.find((entry) => entry.id === split.providerId);
  if (provider == null) {
    // Claude model ids never contain a colon, so this can only be a provider that was deleted.
    throw new BadRequestError(`没有叫 ${JSON.stringify(split.providerId)} 的提供商，可能已被删除；请给这个任务换一个模型`, "invalid_model");
  }
  const agent = provider.agents["claude-code"];
  if (agent == null) {
    throw new BadRequestError(`提供商「${provider.name}」没有给 Claude Code 配置接入地址`, "invalid_model");
  }
  const { auth, env } = claudeCodeProviderEnv({
    baseURL: agent.baseURL,
    ...(provider.apiKey != null ? { apiKey: provider.apiKey } : {}),
    model: split.modelId,
  });
  return { model: split.modelId, auth, env };
}

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
 * the next `createSession({ resumeFrom })` hangs forever on a dead port. Inside
 * one process the run manager parks such a runner and calls `stream()` on the
 * same session again. Across a *graceful* restart it calls `suspend()`, which
 * freezes the turn and leaves the bridge running, and the next turn attaches to
 * it with `continueFrom` — then drives it with `continueStream()`, because
 * there is no new prompt, only the human's answer.
 *
 * No `ensureAvailable`: authentication is an environment the engine builds
 * (`defaultClaudeCodeAuth`), and a subscription login lives in `~/.claude` or
 * the macOS keychain where the bridge's own `claude` CLI reads it — there is no
 * probe for that which is both cheap and honest. A missing login surfaces as a
 * stream error part from the runtime instead.
 */
export function createClaudeCodeEngineFactory(): EngineFactory {
  return {
    descriptor: DESCRIPTOR,

    async create(ctx: EngineContext): Promise<EngineRunner> {
      // Only a turn that is being continued may attach to a suspended one; a
      // fresh prompt abandons it and starts from the last finished state.
      const continueFrom = ctx.continuesTurn ? ctx.harnessState?.continueFrom : undefined;
      const resumeFrom = continueFrom == null ? ctx.harnessState?.resumeFrom : undefined;

      const route = providerRoute(ctx.thread.model, await createProviderStore(ctx.dataDir, ctx.log).list());

      const engine = await createClaudeCodeEngine({
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.permissionMode,
        ...(route != null ? route : ctx.thread.model != null ? { model: ctx.thread.model } : {}),
        // 「思考等级」for this engine *is* the harness `thinking` setting, and
        // `summarized` is what puts the reasoning in the stream.
        thinking: claudeCodeThinking(ctx.thread.reasoningEffort),
        // 计划回合只读：enforced at the SDK level, not asked for in prose.
        ...(ctx.planMode ? { activeTools: PLAN_ACTIVE_TOOLS, instructions: PLAN_INSTRUCTIONS } : {}),
        sessionId: ctx.thread.id,
        ...(continueFrom != null ? { continueFrom } : {}),
        ...(resumeFrom != null ? { resumeFrom } : {}),
      }).catch((error) => {
        // Attaching is the one failure mode the run manager has to treat
        // specially: the turn the client is answering no longer exists.
        if (continueFrom == null) throw error;
        throw new TurnResumeFailedError("服务重启后未能恢复这一轮，请重新发送", { cause: error });
      });

      let ended = false;
      /** The first `stream()` after an attach continues the frozen turn instead of starting one. */
      let pendingContinuation = continueFrom != null;

      return {
        hasUnfinishedTurn: () => engine.session.hasUnfinishedTurn(),

        async stream({ messages, abortSignal }) {
          // A denied approval reaches the harness as an approval continuation,
          // never as the synthetic result `convertToModelMessages` pairs it
          // with — see `stripDeniedApprovalResults`. Both paths below collect
          // their continuations from this array, so it is sanitized once here.
          const harnessMessages = stripDeniedApprovalResults(messages);
          if (pendingContinuation) {
            pendingContinuation = false;
            // The session was created from `continueFrom`, so its turn is
            // already in flight inside the bridge: there is no prompt to send,
            // only the answers the client just posted. They are the same
            // trailing `role: 'tool'` parts `stream()` would have picked out.
            const result = await engine.harnessAgent.continueStream({
              session: engine.session,
              toolApprovalContinuations: collectHarnessAgentToolApprovalContinuations({ messages: harnessMessages }),
              toolResultContinuations: collectHarnessAgentToolResultContinuations({ messages: harnessMessages }),
              abortSignal,
            });
            return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
          }
          // The whole converted history goes in on purpose. The harness session
          // owns its own native history and collapses the array to its last
          // `role: 'user'` message, but an approval continuation needs the
          // matching `tool-approval-request` from the prior assistant message
          // to still be in the array to resolve its approval id.
          // `options: undefined` is required by the call-options generic; this agent has no `callOptionsSchema`.
          const result = await engine.harnessAgent.stream({
            session: engine.session,
            messages: harnessMessages,
            abortSignal,
            options: undefined,
          });
          return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
        },

        async destroy() {
          if (ended) return;
          ended = true;
          await engine.dispose().catch((error) => ctx.log.warn(`销毁 harness session 失败 (thread ${ctx.thread.id})`, error));
        },

        async suspend() {
          if (ended) throw new Error(`Claude Code 引擎已经结束，无法挂起 (thread ${ctx.thread.id})`);
          // The handle is detached by `suspendTurn()` itself, so nothing may
          // stop or destroy it afterwards — that would take the bridge down
          // with the turn we just froze.
          const continueTurn = await engine.suspend();
          ended = true;
          return {
            version: 1,
            sessionId: ctx.thread.id,
            // Kept alongside: if the bridge is gone by the time someone
            // answers, the thread still has a finished turn to restart from.
            ...(ctx.harnessState?.resumeFrom != null ? { resumeFrom: ctx.harnessState.resumeFrom } : {}),
            continueFrom: continueTurn,
            updatedAt: new Date().toISOString(),
          };
        },

        async finish() {
          if (ended) return;
          ended = true;
          try {
            const state = await engine.stop();
            // A finished turn supersedes any suspended one: the harness file
            // must not keep pointing at a bridge this `stop()` just killed.
            await ctx.saveHarnessState({
              version: 1,
              sessionId: ctx.thread.id,
              resumeFrom: state,
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
