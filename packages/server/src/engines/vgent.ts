import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_SUBSCRIPTION_PREFIX, connectMcpServers, createVgentEngine, loadSkillsIndex } from "@vgent/engine";
import { describeSubscriptionAuth } from "@vgent/providers";
import type { LanguageModel, TextStreamPart, ToolSet } from "ai";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import { createSettingsStore } from "../store/settings.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/** What a `vgent` thread runs on when it names no model of its own. */
export const DEFAULT_VGENT_MODEL = "codex-subscription:gpt-5.5";

/** Either of these lets the AI Gateway authenticate a `provider/model` spec. */
const GATEWAY_ENV_VARS = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const;

type ModelSpec = { kind: "codex-subscription" } | { kind: "gateway" } | { kind: "invalid"; reason: string };

/**
 * Where a project's cross-task memory lives: `<dataDir>/memory/<project>`.
 * Keyed on the *project*, not the thread, so every task of the same repository
 * reads and writes the same notes — and on `dataDir` rather than the worktree,
 * so reclaiming a task's directory does not take its memory with it.
 */
function memoryDirOf(ctx: EngineContext): string {
  const key = `${ctx.project.name}-${ctx.project.id.slice(0, 8)}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return join(ctx.dataDir, "memory", key);
}

/**
 * What a thread's model string routes to. Mirrors `resolveModel` in
 * `@vgent/engine` — the function that really builds the model — so an unusable
 * spec is a typed 400 before the run starts instead of an error part inside a
 * 200 stream. Deliberately a re-check rather than a call: `resolveModel`
 * constructs a provider, which is not what a precondition should do.
 */
function describeModelSpec(spec: string): ModelSpec {
  if (spec.startsWith(CODEX_SUBSCRIPTION_PREFIX)) {
    return spec.length > CODEX_SUBSCRIPTION_PREFIX.length
      ? { kind: "codex-subscription" }
      : { kind: "invalid", reason: `${CODEX_SUBSCRIPTION_PREFIX} 后面缺少模型 id` };
  }
  const separator = spec.indexOf("/");
  if (separator <= 0 || separator === spec.length - 1 || spec.includes(" ")) {
    return { kind: "invalid", reason: '应为 "provider/model" 或 "codex-subscription:<模型 id>"' };
  }
  return { kind: "gateway" };
}

export interface VgentEngineFactoryOptions {
  /**
   * Overrides the model the thread names. A test seam: it lets a suite drive
   * the real factory with a `MockLanguageModelV3` and skips the availability
   * probe, since an injected model needs no credential.
   */
  model?: LanguageModel;
}

/**
 * Vgent's own engine — a plain `ToolLoopAgent` — behind the same `EngineRunner`
 * contract as the harness engines.
 *
 * It is *stateless* between turns: the SDK's loop, approvals and tool results
 * all live in the message array the server already stores, so nothing has to be
 * persisted alongside it. That is why there is no `sessionFile` (the server owns
 * the history), why `hasUnfinishedTurn()` is always false, and why `finish()`
 * must not write a `<id>.harness.json` — there is no resume state, and an empty
 * one would only confuse the harness engines' loader.
 */
export function createVgentEngineFactory(options: VgentEngineFactoryOptions = {}): EngineFactory {
  const { model: override } = options;

  return {
    statelessTurns: true,

    async ensureAvailable({ thread }) {
      if (override != null) return;
      const spec = thread.model ?? DEFAULT_VGENT_MODEL;
      const described = describeModelSpec(spec);
      if (described.kind === "invalid") {
        throw new BadRequestError(`模型标识不合法: ${JSON.stringify(spec)}，${described.reason}`, "invalid_model");
      }
      if (described.kind === "codex-subscription") {
        const report = await describeSubscriptionAuth();
        if (!report.codex.available) {
          throw new EngineUnavailableError("Codex 未登录：找不到可用的 ChatGPT / Codex 登录态（~/.codex/auth.json，或 CODEX_HOME）");
        }
        return;
      }
      if (!GATEWAY_ENV_VARS.some((name) => (process.env[name] ?? "") !== "")) {
        throw new EngineUnavailableError(`未配置 AI Gateway 凭证：模型 ${JSON.stringify(spec)} 需要环境变量 AI_GATEWAY_API_KEY 或 VERCEL_OIDC_TOKEN`);
      }
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      // Both are re-read per turn, so editing settings or adding a skill takes
      // effect on the next message instead of on the next server restart.
      const settings = await createSettingsStore(ctx.dataDir, ctx.log).get();
      const mcp = await connectMcpServers(settings.mcpServers ?? [], { log: ctx.log });
      const skills = await loadSkillsIndex([
        join(ctx.project.repoPath, ".claude", "skills"),
        join(homedir(), ".vgent", "skills"),
      ]);

      const model = override ?? ctx.thread.model ?? DEFAULT_VGENT_MODEL;
      const { workspace } = ctx.thread;

      const engine = createVgentEngine({
        model,
        repoPath: ctx.project.repoPath,
        permissionMode: ctx.thread.permissionMode,
        ...(ctx.thread.alwaysAllow != null ? { alwaysAllow: ctx.thread.alwaysAllow } : {}),
        extraTools: mcp.tools,
        skills,
        memoryDir: memoryDirOf(ctx),
        // The summary is always asked for (that is the engine's default); the
        // effort only when the task names one.
        reasoning: { ...(ctx.thread.reasoningEffort != null ? { effort: ctx.thread.reasoningEffort } : {}) },
        // Everything the model cannot work out for itself: which model it is,
        // which front end it is answering through, and whether this directory
        // is the project or a worktree cut from it.
        context: {
          modelId: typeof model === "string" ? model : model.modelId,
          host: process.env.VGENT_DESKTOP === "1" ? "Vgent desktop app (macOS)" : "Vgent web",
          ...(workspace == null
            ? {}
            : {
                workspace: {
                  path: workspace.path,
                  projectPath: ctx.projectPath,
                  branch: workspace.branch,
                  baseCommit: workspace.baseCommit,
                },
              }),
        },
      });

      let ended = false;
      const release = async () => {
        if (ended) return;
        ended = true;
        await mcp.close().catch((error) => ctx.log.warn(`关闭 MCP 连接失败 (thread ${ctx.thread.id})`, error));
        await engine.dispose().catch((error) => ctx.log.warn(`释放 Vgent 引擎失败 (thread ${ctx.thread.id})`, error));
      };

      return {
        // What `convertToModelMessages` needs to turn a subagent's stored
        // transcript back into the one-paragraph summary the model saw.
        tools: engine.tools,

        // The agent holds no runtime between calls: a paused turn is only the
        // open tool part in the stored messages.
        hasUnfinishedTurn: () => false,

        async stream({ messages, abortSignal }) {
          // The whole history goes in every time. The SDK resolves an approval
          // continuation out of it (the trailing `role: 'tool'` message carries
          // the `tool-approval-response` parts) and an `askUserQuestions` answer
          // the same way, as that tool's output.
          // `options: undefined` is required by the call-options generic; this agent has no `callOptionsSchema`.
          const result = await engine.agent.stream({ messages, abortSignal, options: undefined });
          return { stream: result.stream as ReadableStream<TextStreamPart<ToolSet>> };
        },

        // Nothing to persist, so both endings are the same release. In
        // particular `finish()` never calls `saveHarnessState`.
        destroy: release,
        finish: release,
      };
    },
  };
}
