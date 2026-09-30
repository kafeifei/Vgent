import { homedir } from "node:os";
import { join } from "node:path";
import {
  agentInstructionsSection,
  CODEX_SUBSCRIPTION_PREFIX,
  connectMcpServers,
  createVgentEngine,
  loadAgentInstructions,
  loadSkillsIndex,
} from "@vgent/engine";
import { cuaMcpConfig, onlyCuaTools, requireCuaDriver } from "../computer-use/cua.js";
import { createCodexSubscriptionModel, describeModelSpec, describeSubscriptionAuth } from "@vgent/providers";
import { DEFAULT_ACCOUNT, splitAccountSpec } from "../accounts/spec.js";
import type { AccountId } from "../accounts/types.js";
import type { LanguageModel, TextStreamPart, ToolSet } from "ai";
import { BadRequestError, EngineUnavailableError } from "../errors.js";
import { createProviderStore } from "../store/providers.js";
import { createSettingsStore } from "../store/settings.js";
import { isNoProject } from "../no-project.js";
import { expandSteers } from "../steer.js";
import type { EngineDescriptor } from "./capabilities.js";
import { PROVIDER_DEFAULT_LEVEL, effectiveReasoningLevel } from "../reasoning.js";
import type { EngineContext, EngineFactory, EngineRunner } from "./registry.js";

/** 引擎能力表, the 自研 row: everything, because everything in it is ours. */
const DESCRIPTOR: EngineDescriptor = {
  id: "vgent",
  label: "Vgent",
  capabilities: {
    approvals: true,
    askUser: true,
    planMode: true,
    compact: true,
    knownDefaultModel: true,
    extensions: true,
    // Pulled: the loop is ours, so the queue is read between steps (`takeSteers`).
    steer: true,
    customProviders: true,
  },
};

/** What a `vgent` thread runs on when it names no model of its own. */
export const DEFAULT_VGENT_MODEL = "codex-subscription:gpt-5.5";

/** Either of these lets the AI Gateway authenticate a `provider/model` spec. */
const GATEWAY_ENV_VARS = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"] as const;

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

export interface VgentEngineFactoryOptions {
  /**
   * Overrides the model the thread names. A test seam: it lets a suite drive
   * the real factory with a `MockLanguageModelV3` and skips the availability
   * probe, since an injected model needs no credential.
   */
  model?: LanguageModel;
  /** One GitHub account's Copilot. */
  copilot?: (account: AccountId) => { available(): Promise<void>; model(id: string): Promise<LanguageModel> };
  /** Where a Codex account keeps its login, and whether an account is still there. */
  accounts?: { codexHome(id: AccountId): string; ensure(id: AccountId): Promise<void> };
  /**
   * The window the model list gives a model — the one the composer's ring is
   * drawn against — for a task that chose none. Unset or unknown, the engine
   * falls back to its own default budget.
   */
  windowOf?: (model: string) => Promise<number | undefined>;
}

/**
 * The model a spec names for the in-house engine, when it is one only an
 * account can run: a Copilot model, or a Codex model on another account than
 * the machine's (the machine's own Codex login resolves by name, as before).
 * Anything else is left to the engine's model registry.
 */
export async function accountModel(model: string, options: Pick<VgentEngineFactoryOptions, "copilot" | "accounts">): Promise<LanguageModel | undefined> {
  const { accountId, spec } = splitAccountSpec(model);
  if (spec.startsWith("github-copilot:") && options.copilot != null) return options.copilot(accountId ?? DEFAULT_ACCOUNT.github).model(spec.slice("github-copilot:".length));
  if (accountId != null && spec.startsWith(CODEX_SUBSCRIPTION_PREFIX) && options.accounts != null) {
    return createCodexSubscriptionModel(spec.slice(CODEX_SUBSCRIPTION_PREFIX.length), { env: { ...process.env, CODEX_HOME: options.accounts.codexHome(accountId) } });
  }
  return undefined;
}

/** How much of a chosen window the history may fill before pruning; the rest is the reply's and the tools'. */
const CONTEXT_BUDGET_SHARE = 0.8;

/**
 * Vgent's own engine — a plain `ToolLoopAgent` — behind the same `EngineRunner`
 * contract as the harness engines.
 *
 * It is *stateless* between turns: the SDK's loop, approvals and tool results
 * all live in the message array the server already stores, so nothing has to be
 * retained in a separate runtime. Task state, compaction cache and child reports
 * are durable local records. There is no `sessionFile` (the server owns
 * the history), why `hasUnfinishedTurn()` is always false, and why `finish()`
 * must not write a `<id>.harness.json` — there is no resume state, and an empty
 * one would only confuse the harness engines' loader.
 */
export function createVgentEngineFactory(options: VgentEngineFactoryOptions = {}): EngineFactory {
  const { model: override } = options;

  return {
    descriptor: DESCRIPTOR,
    statelessTurns: true,

    // A precondition, so an unusable model is a typed 400 / 503 before the run
    // starts instead of an error part inside a 200 stream. It reads the same
    // classifier the registry resolves with, so the two cannot disagree.
    async ensureAvailable({ thread, dataDir }) {
      if (override != null) return;
      const { accountId, spec } = splitAccountSpec(thread.model ?? DEFAULT_VGENT_MODEL);
      if (accountId != null) await options.accounts?.ensure(accountId);
      if (spec.startsWith("github-copilot:") && options.copilot) { await options.copilot(accountId ?? DEFAULT_ACCOUNT.github).available(); return; }
      const described = describeModelSpec(spec, await createProviderStore(dataDir).list());
      if (described.kind === "invalid") {
        throw new BadRequestError(`模型标识不合法: ${JSON.stringify(spec)}，${described.reason}`, "invalid_model");
      }
      if (described.kind === "provider") {
        // A local server (Ollama, LM Studio) legitimately has no key, so its
        // absence is not checked here; a wrong or missing one comes back as the
        // provider's own 401 in the stream.
        return;
      }
      if (described.kind === "codex-subscription") {
        const home = options.accounts?.codexHome(accountId ?? DEFAULT_ACCOUNT.codex);
        const report = await describeSubscriptionAuth(home != null ? { env: { ...process.env, CODEX_HOME: home } } : {});
        if (!report.codex.available) {
          throw new EngineUnavailableError("Codex 未登录：在「账号」里添加一个 Codex 账号");
        }
        return;
      }
      if (!GATEWAY_ENV_VARS.some((name) => (process.env[name] ?? "") !== "")) {
        throw new EngineUnavailableError(
          `未配置 AI Gateway 凭证：模型 ${JSON.stringify(spec)} 需要环境变量 AI_GATEWAY_API_KEY 或 VERCEL_OIDC_TOKEN`,
        );
      }
    },

    async create(ctx: EngineContext): Promise<EngineRunner> {
      // Both are re-read per turn, so editing settings or adding a skill takes
      // effect on the next message instead of on the next server restart.
      const settings = await createSettingsStore(ctx.dataDir, ctx.log).get();
      const cuaBinary = settings.computerUseProvider === "cua" ? await requireCuaDriver() : undefined;
      const providers = await createProviderStore(ctx.dataDir, ctx.log).list();
      const skills = await loadSkillsIndex([
        join(ctx.project.repoPath, ".agents", "skills"),
        join(ctx.project.repoPath, ".claude", "skills"),
        join(homedir(), ".vgent", "skills"),
        join(homedir(), ".agents", "skills"),
        join(homedir(), ".claude", "skills"),
      ]);
      // ~/.agents/AGENTS.md plus the repository's AGENTS.md.
      const standing = agentInstructionsSection(await loadAgentInstructions({ repoPath: ctx.project.repoPath }));
      const cua = cuaBinary == null ? undefined : await connectMcpServers([cuaMcpConfig(cuaBinary)], { log: ctx.log });
      const cuaTools = cua == null ? {} : onlyCuaTools(cua.tools);
      if (cua != null && Object.keys(cuaTools).length === 0) {
        await cua.close();
        throw new Error("Cua Driver MCP 连接失败；请到设置 → Computer Use 检查服务");
      }
      let mcp: Awaited<ReturnType<typeof connectMcpServers>> | undefined;
      let engine: ReturnType<typeof createVgentEngine>;
      try {
        mcp = await connectMcpServers(settings.mcpServers ?? [], { log: ctx.log });
        const spec = ctx.thread.model ?? DEFAULT_VGENT_MODEL;
        const model = override ?? (await accountModel(spec, options)) ?? spec;
        // A task that chose no window runs on the model's own, the one its ring
        // shows — not on the engine's 150K default, which is smaller than most.
        const window = ctx.thread.contextWindow ?? (await options.windowOf?.(spec).catch(() => undefined));
        const { workspace } = ctx.thread;
        engine = createVgentEngine({
          model,
          providers,
          sessionId: ctx.thread.id,
          repoPath: ctx.project.repoPath,
          projectPath: ctx.projectPath,
          outputDir: join(ctx.dataDir, "outputs", ctx.thread.id),
          ...(ctx.thread.taskState ? { taskState: ctx.thread.taskState } : {}),
          ...(ctx.saveTaskState ? { saveTaskState: ctx.saveTaskState } : {}),
          memorySources: expandSteers(ctx.thread.messages)
            .filter((message) => message.role === "user")
            .map((message) => ({
              id: message.id,
              text: message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
            })),
          permissionMode: ctx.permissionMode,
          ...(ctx.alwaysAllow.length > 0 ? { alwaysAllow: ctx.alwaysAllow } : {}),
          // 计划回合只读：the engine drops every writing tool, MCP included.
          ...(ctx.planMode ? { plan: true } : {}),
          extraTools: { ...mcp.tools, ...cuaTools },
          // 插话: whatever the user sent since the last step goes in before the next one.
          pendingUserMessages: ctx.takeSteers,
          ...(standing === "" ? {} : { instructions: standing }),
          skills,
          memoryDir: memoryDirOf(ctx),
          // The summary is always asked for (that is the engine's default); the
          // effort is the task's, or 高. A model that does not reason ignores it.
          // 「不指定」sends none, for an endpoint that refuses the parameter.
          reasoning:
            ctx.thread.reasoningEffort === PROVIDER_DEFAULT_LEVEL ? {} : { effort: effectiveReasoningLevel(ctx.thread.reasoningEffort) },
          // 上下文: the in-house engine has no window setting to pass on — what it
          // owns is when to start pruning, so a chosen window moves that line.
          ...(window != null ? { contextTokenBudget: Math.floor(window * CONTEXT_BUDGET_SHARE) } : {}),
          // Fast: the Responses API's `service_tier`, for the models that offer one.
          ...(ctx.thread.serviceTier != null ? { serviceTier: ctx.thread.serviceTier } : {}),
          // Everything the model cannot work out for itself: which model it is,
          // which front end it is answering through, and whether this directory
          // is the project or a worktree cut from it.
          context: {
            workspaceKind: isNoProject(ctx.thread.projectId) ? "scratch" : "project",
            modelId: typeof model === "string" ? model : model.modelId,
            host: process.env.VGENT_DESKTOP === "1" ? "Vgent desktop app (macOS)" : "Vgent web",
            ...(workspace == null
              ? {}
              : {
                  workspace: {
                    branch: workspace.branch,
                    baseCommit: workspace.baseCommit,
                  },
                }),
          },
        });
      } catch (error) {
        await mcp?.close();
        await cua?.close();
        throw error;
      }

      let ended = false;
      const release = async () => {
        if (ended) return;
        ended = true;
        await mcp.close().catch((error) => ctx.log.warn(`关闭 MCP 连接失败 (thread ${ctx.thread.id})`, error));
        await cua?.close().catch((error) => ctx.log.warn(`关闭 Cua 连接失败 (thread ${ctx.thread.id})`, error));
        await engine.dispose().catch((error) => ctx.log.warn(`释放 Vgent 引擎失败 (thread ${ctx.thread.id})`, error));
      };

      return {
        // What `convertToModelMessages` needs to turn a subagent's stored
        // transcript back into the one-paragraph summary the model saw.
        tools: engine.tools,
        outcome: engine.outcome,

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
