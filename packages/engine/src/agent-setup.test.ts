import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { createModelRegistry, type ProviderConfig } from "@vgent/providers";
import { createVgentEngine } from "./engine.js";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSetup } from "./agent-setup.js";
import { createMemoryTool } from "./memory.js";

const execution = { toolCallId: "test", messages: [] };
let root: string;
let repoPath: string;
let projectPath: string;
let skillPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "vgent-setup-"));
  repoPath = join(root, "worktree");
  projectPath = join(root, "project");
  skillPath = join(root, "skills", "deploy");
  await Promise.all([repoPath, projectPath, skillPath].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(skillPath, "SKILL.md"), "Deploy instructions");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("shared agent setup", () => {
  it("gives parent and child the same configured path capabilities and descriptions", async () => {
    for (const interactive of [true, false]) {
      const { tools, instructions } = createAgentSetup({
        repoPath, projectPath, permissionMode: "allow-edits", interactive,
        skills: [{ name: "deploy", description: "Delivery", path: join(skillPath, "SKILL.md") }],
      });
      expect(tools.write!.description).toContain(projectPath);
      expect(tools.write!.description).not.toContain(skillPath);
      expect(tools.read!.description).toContain(skillPath);
      expect(tools.bash!.description).toContain("not an OS sandbox");
      expect(instructions).toContain(join(skillPath, "SKILL.md"));
      const file_path = join(projectPath, `delivery-${interactive}.txt`);
      await tools.write!.execute!({ file_path, content: "delivered" }, execution);
      expect(await readFile(file_path, "utf8")).toBe("delivered");
      expect(await tools.read!.execute!({ file_path: join(skillPath, "SKILL.md") }, execution)).toMatchObject({ content: expect.stringContaining("Deploy instructions") });
      await expect(tools.write!.execute!({ file_path: join(skillPath, "new.txt"), content: "no" }, execution)).rejects.toThrow(/outside the working directory/);
    }
    const limited = createAgentSetup({ repoPath, permissionMode: "allow-edits" });
    expect(limited.tools.write!.description).not.toContain(projectPath);
    await expect(limited.tools.write!.execute!({ file_path: join(projectPath, "no.txt"), content: "no" }, execution)).rejects.toThrow(/outside the working directory/);
  });

  it("executes standing approvals in a child and rejects other actions before they affect files", async () => {
    const setup = createAgentSetup({ repoPath, permissionMode: "allow-reads", alwaysAllow: ["write", "bash(touch)"], interactive: false });
    expect(setup.instructions).toContain('"write","bash(touch)"');
    expect(setup.instructions).toContain("are denied in this subagent");
    await setup.tools.write!.execute!({ file_path: "allowed.txt", content: "original" }, execution);
    for await (const _ of setup.tools.bash!.execute!({ command: "touch shell-approved.txt" }, execution) as AsyncIterable<unknown>) { /* consume streamed execution */ }
    expect(await readFile(join(repoPath, "shell-approved.txt"), "utf8")).toBe("");
    expect(() => setup.tools.edit!.execute!({ file_path: "allowed.txt", old_string: "original", new_string: "changed" }, execution)).toThrow(/需要审批/);
    expect(() => setup.tools.bash!.execute!({ command: "rm allowed.txt" }, execution)).toThrow(/需要审批/);
    expect(await readFile(join(repoPath, "allowed.txt"), "utf8")).toBe("original");
  });

  it("selects tools before building context, so excluded memory and deferred tools contribute no instructions", () => {
    const extraTools = {
      memory: createMemoryTool(join(root, "memory")),
      external: tool({ inputSchema: z.object({}), description: "EXTERNAL_SENTINEL", deferLoading: true, execute: async () => "ok" }),
    };
    const normal = createAgentSetup({ repoPath, permissionMode: "allow-reads", extraTools });
    expect(normal.tools.memory!.description).toContain(join(root, "memory"));
    expect(normal.tools.toolSearch).toBeDefined();
    expect(normal.instructions).not.toContain("EXTERNAL_SENTINEL");
    const plan = createAgentSetup({ repoPath, permissionMode: "allow-reads", extraTools, allowedTools: ["read", "grep", "glob"], plan: true });
    expect(Object.keys(plan.tools)).toEqual(["read", "grep", "glob"]);
    expect(plan.instructions).not.toContain("memory");
    expect(plan.instructions).not.toContain("toolSearch");
    expect(plan.instructions).not.toContain("EXTERNAL_SENTINEL");
  });
});


describe("hosted tool search setup", () => {
  const model = new MockLanguageModelV3({ provider: "codex-subscription.responses", modelId: "gpt-6-astra" });
  const candidate = () => tool({
    description: "PRIVATE_CANDIDATE_DESCRIPTION",
    inputSchema: z.object({}),
    deferLoading: true,
    providerOptions: { openai: { strict: true }, other: { retained: true } },
    execute: async () => "executed",
  });

  it("keeps candidates hidden, clones options, and preserves approval and execution guards", async () => {
    const original = candidate();
    const extraTools = { srv__private_candidate: original };
    const setup = createAgentSetup({ repoPath, permissionMode: "allow-reads", model, extraTools });
    expect(setup.tools.tool_search).toMatchObject({ type: "provider", id: "openai.tool_search", args: {} });
    expect(setup.tools.toolSearch).toBeUndefined();
    expect(setup.instructions).toContain("let the approval system handle it");
    const converted = setup.tools.srv__private_candidate!;
    expect(converted).not.toHaveProperty("deferLoading");
    expect(converted.providerOptions).toEqual({ openai: { strict: true, deferLoading: true }, other: { retained: true } });
    expect(converted.inputSchema).toBe(original.inputSchema);
    expect(setup.instructions).not.toContain("srv__private_candidate");
    expect(setup.instructions).not.toContain("PRIVATE_CANDIDATE_DESCRIPTION");
    expect(setup.toolApproval({ toolCall: { toolName: "srv__private_candidate", input: {} } })).toBe("user-approval");
    expect(extraTools.srv__private_candidate).toBe(original);
    expect(original.deferLoading).toBe(true);
    expect(original.providerOptions).toEqual({ openai: { strict: true }, other: { retained: true } });
    await expect(converted.execute!({}, execution)).resolves.toBe("executed");
    const child = createAgentSetup({ repoPath, permissionMode: "allow-reads", model, extraTools, interactive: false });
    expect(() => child.tools.srv__private_candidate!.execute!({}, execution)).toThrow(/需要审批/);
    const closing = createAgentSetup({ repoPath, permissionMode: "allow-all", model, extraTools, canExecute: () => false });
    expect(() => closing.tools.srv__private_candidate!.execute!({}, execution)).toThrow(/budget exhausted/);
  });

  it("filters plan tools before search creation and adds no search without deferred candidates", () => {
    const setup = createAgentSetup({ repoPath, permissionMode: "allow-reads", model, extraTools: { srv__private_candidate: candidate() }, allowedTools: ["read", "grep", "glob"], plan: true });
    expect(Object.keys(setup.tools)).toEqual(["read", "grep", "glob"]);
    expect(setup.instructions).not.toContain("toolSearch");
    expect(setup.instructions).not.toContain("srv__private_candidate");
    expect(setup.instructions).not.toContain("PRIVATE_CANDIDATE_DESCRIPTION");
    expect(createAgentSetup({ repoPath, permissionMode: "allow-reads", model }).tools.toolSearch).toBeUndefined();
  });

  it.each([
    ["custom-official", "https://api.openai.com/v1", true],
    ["openai", "https://third-party.example/v1", false],
  ] as const)("uses configured endpoint rather than %s name in setup and engine", async (id, baseURL, hosted) => {
    const providers: ProviderConfig[] = [{ id, name: id, apiKey: "fake-key", agents: {
      vgent: { protocol: "openai", baseURL, models: [{ id: "gpt-6-astra" }] },
    } }];
    const spec = `${id}:gpt-6-astra`;
    const options = { repoPath, permissionMode: "allow-all" as const, providers, extraTools: { external: candidate() } };
    const setup = createAgentSetup({ ...options, model: createModelRegistry({ providers }).languageModel(spec) });
    const engine = createVgentEngine({ ...options, model: spec, subagents: false });
    try {
      for (const tools of [setup.tools, engine.agent.tools]) {
        expect(tools.tool_search?.id === "openai.tool_search").toBe(hosted);
        expect(tools.toolSearch != null).toBe(!hosted);
        expect(tools.external?.deferLoading).toBe(hosted ? undefined : true);
        expect(tools.external?.providerOptions?.openai?.deferLoading).toBe(hosted ? true : undefined);
      }
    } finally {
      await engine.dispose();
    }
  });

  it("retains generic search and top-level deferral for older models", () => {
    const setup = createAgentSetup({ repoPath, permissionMode: "allow-reads", model: new MockLanguageModelV3({ provider: "openai.responses", modelId: "gpt-5.3" }), extraTools: { external: candidate() } });
    expect(setup.tools.toolSearch?.id).not.toBe("openai.tool_search");
    expect(setup.tools.toolSearch?.description).toContain("matching tools become callable on the next step");
    expect(setup.tools.external?.deferLoading).toBe(true);
  });
});
