import { dirname, resolve } from "node:path";
import { createCodingTools } from "@vgent/tools";
import { createOpenAIToolSearch, type ProviderConfig } from "@vgent/providers";
import { toolSearch, type LanguageModel, type ToolSet } from "ai";
import { agentInstructionsSection, loadScopedInstructions } from "./agent-instructions.js";
import { buildInstructions, type VgentContext } from "./instructions.js";
import { hasDeferredTools } from "./mcp.js";
import { createApprovalPolicy, type PermissionMode } from "./permissions.js";
import type { SkillSummary } from "./skills.js";

/** Inputs already supplied by the host or parent. No session state is owned here. */
export interface AgentSetupOptions {
  repoPath: string;
  projectPath?: string | undefined;
  outputDir?: string | undefined;
  readRoots?: readonly string[] | undefined;
  permissionMode: PermissionMode;
  alwaysAllow?: readonly string[] | undefined;
  context?: VgentContext | undefined;
  skills?: readonly SkillSummary[] | undefined;
  instructions?: string | undefined;
}

/** The same assembly path for the top-level agent and its children. */
export function createAgentSetup(options: AgentSetupOptions & {
  model?: LanguageModel;
  providers?: readonly ProviderConfig[] | undefined;
  extraTools?: ToolSet;
  allowedTools?: readonly string[];
  role?: string;
  plan?: boolean;
  interactive?: boolean;
  canExecute?: () => boolean;
}) {
  const repoPath = resolve(options.repoPath);
  const projectPath = options.projectPath ? resolve(repoPath, options.projectPath) : undefined;
  const interactive = options.interactive !== false;
  const policy = createApprovalPolicy(options.permissionMode, options.alwaysAllow);
  const coding = createCodingTools({
    workDir: repoPath,
    readRoots: [...new Set([...(options.readRoots ?? []), ...(options.skills ?? []).map((skill) => dirname(skill.path))])],
    ...(projectPath ? { writeRoots: [projectPath] } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
  });
  for (const name of Object.keys(options.extraTools ?? {})) {
    if (name in coding) throw new Error(`Extra tool collides with built-in tool: ${name}`);
  }
  const all = { ...coding, ...options.extraTools };
  const tools: ToolSet = options.allowedTools
    ? Object.fromEntries(options.allowedTools.filter((name) => all[name] != null).map((name) => [name, all[name]!]))
    : all;
  const nativeSearch = hasDeferredTools(tools) ? createOpenAIToolSearch(options.model, options.providers) : undefined;
  if (nativeSearch) {
    // Keep the generic toolSearch name for old history. Reusing it would make
    // the provider reinterpret saved function calls as native search items.
    tools.tool_search = nativeSearch;
  } else if (hasDeferredTools(tools)) {
    const search = toolSearch();
    tools.toolSearch = {
      ...search,
      description: `${search.description ?? "Search available tools."} Find additional tools by name and description; matching tools become callable on the next step.`,
    };
  }
  // A subdirectory's AGENTS.md arrives with the first read that reaches it, as
  // part of that tool result. A request may only grow at its end: rewriting the
  // system prompt halfway through a task throws away the provider's prompt cache.
  const read = tools.read;
  if (read?.execute != null) {
    const execute = read.execute;
    const delivered = new Set<string>();
    tools.read = {
      ...read,
      execute: async (input, execution) => {
        const result = (await execute(input, execution)) as { path?: unknown };
        if (typeof result?.path !== "string") return result;
        const rules = (await loadScopedInstructions(repoPath, [result.path])).filter((file) => !delivered.has(file.path));
        for (const file of rules) delivered.add(file.path);
        return rules.length === 0 ? result : { ...result, instructions: agentInstructionsSection(rules) };
      },
    };
  }
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) continue;
    tools[name] = {
      ...definition,
      execute: (input, execution) => {
        execution.abortSignal?.throwIfAborted();
        if (options.canExecute?.() === false) throw new Error("Execution budget exhausted; no new tool action was started.");
        if (!interactive && policy.toolApproval({ toolCall: { toolName: name, input } }) === "user-approval") {
          throw new Error(`子代理不能执行需要审批的操作：${name}（当前权限模式 ${options.permissionMode}）`);
        }
        return execute(input, execution);
      },
    };
  }
  const instructions = buildInstructions({
    repoPath,
    ...(projectPath ? { projectPath } : {}),
    tools,
    approvalInstructions: policy.describe(Object.keys(tools).filter((name) => !tools[name]!.deferLoading), interactive),
    ...(options.context ? { context: options.context } : {}),
    ...(options.skills ? { skills: options.skills } : {}),
    ...(options.instructions ? { extra: options.instructions } : {}),
    ...(options.role ? { role: options.role } : {}),
    ...(options.plan ? { plan: true } : {}),
  });
  // Build instructions while deferred candidates are still hidden by the SDK flag.
  if (nativeSearch) {
    for (const [name, definition] of Object.entries(tools)) {
      if (!definition.deferLoading) continue;
      const { deferLoading: _, ...candidate } = definition;
      tools[name] = {
        ...candidate,
        providerOptions: {
          ...candidate.providerOptions,
          openai: { ...candidate.providerOptions?.openai, deferLoading: true },
        },
      };
    }
  }
  return { tools, toolApproval: policy.toolApproval, instructions };
}
