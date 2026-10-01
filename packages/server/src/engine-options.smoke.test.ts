import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { UIMessage } from "ai";
import { listedCodexModels, readCodexModelCache } from "@vgent/providers";
import { afterEach, expect, it } from "vitest";
import type { EngineOptions } from "./engine-options.js";
import { claudeAccountEnv } from "./accounts/claude.js";
import { createEngineRegistry, type EngineAccounts } from "./engines/registry.js";
import { createRunManager } from "./runs.js";
import { createProjectStore } from "./store/projects.js";
import { createSettingsStore } from "./store/settings.js";
import { createThreadStore } from "./store/threads.js";
import type { EngineId } from "./types.js";

/**
 * 引擎选项 on the real runtimes, with this machine's logins: each switch has to
 * change what the model is really given, not only what the settings file says.
 * The model is asked to name its tools, which is how a switch shows up to it.
 */
const smoke = process.env.VGENT_SMOKE === "1" ? it : it.skip;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A Claude account the app manages, when this machine's own Claude Code is not
 * logged in: `VGENT_SMOKE_CLAUDE_ACCOUNT=claude-…`, from `~/.vgent/accounts.json`.
 */
const claudeAccount = process.env.VGENT_SMOKE_CLAUDE_ACCOUNT;
const accounts = {
  claudeEnv: (id: string) => claudeAccountEnv(join(homedir(), ".vgent"), id as never),
  codexHome: () => join(homedir(), ".codex"),
  ensure: async () => {},
} as unknown as EngineAccounts;
const claudeModel = claudeAccount == null ? undefined : `@${claudeAccount}:sonnet`;
/** No model is written into the tests: the first one this machine's Codex lists, unless named. */
const codexSlug =
  process.env.VGENT_SMOKE_CODEX_MODEL ??
  listedCodexModels((await readCodexModelCache(resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"))))?.models ?? [])[0]?.slug;
const openCodeModel = codexSlug == null ? undefined : `codex-subscription:${codexSlug}`;
/** Codex gives hosted web search only to models off its lite Responses path (gpt-5.5 today). */
const codexSearchModel = process.env.VGENT_SMOKE_CODEX_SEARCH_MODEL ?? codexSlug;

const LIST_TOOLS = "Without calling any tool, reply with the exact names of every tool you can call, comma-separated, and nothing else.";

async function turn(
  engine: EngineId,
  options: Partial<Record<EngineId, EngineOptions>>,
  prompt: string,
  model?: string,
): Promise<{ text: string; tools: string[]; refused: string[] }> {
  const temp = async (prefix: string) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  const dataDir = await temp("vgent-options-data-");
  const repoPath = await temp("vgent-options-repo-");
  await writeFile(join(repoPath, "a.txt"), "alpha\n");
  execFileSync("git", ["init", "--quiet"], { cwd: repoPath });
  const threads = createThreadStore(dataDir);
  const projects = createProjectStore(dataDir);
  const settings = createSettingsStore(dataDir);
  await settings.update({ runMode: "allow-all", engineOptions: options });
  const project = await projects.create({ repoPath });
  const thread = await threads.create({ projectId: project.id, engine, ...(model != null ? { model } : {}) });
  const runs = createRunManager({ threads, projects, settings, dataDir, registry: createEngineRegistry(undefined, { accounts }) });
  try {
    const message: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: prompt }] };
    const hub = await runs.start(thread.id, [message]);
    for await (const _ of hub.subscribe()) {
      /* drain */
    }
    let record = await threads.get(thread.id);
    for (let i = 0; i < 1200 && record?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      record = await threads.get(thread.id);
    }
    expect(record?.error).toBeUndefined();
    const last = record!.messages.at(-1)!;
    const text = last.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    const tools = last.parts.flatMap((part) => (part.type.startsWith("tool-") ? [part.type.slice(5)] : part.type === "dynamic-tool" ? [(part as { toolName: string }).toolName] : []));
    const refused = last.parts.flatMap((part) => (part.type.startsWith("tool-") && (part as { state?: string }).state === "output-error" ? [part.type.slice(5)] : []));
    console.log(`[options] ${engine} ${JSON.stringify(options)}\n  tools called: ${tools.join(", ")}\n  text: ${text.slice(0, 600)}`);
    return { text, tools, refused };
  } finally {
    await runs.stopAll();
  }
}

smoke("Claude Code gets its to-do list on newer models, and loses switched-off tools", async () => {
  const todo = await turn("claude-code", {}, "Use your to-do list tool to record two items, alpha and beta, then reply DONE.", claudeModel);
  expect(todo.tools).toContain("TodoWrite");
  // Some of its tools are deferred behind ToolSearch, so the model is made to look rather than list.
  const SEARCH = "Use ToolSearch to look for tools named WebSearch, WebFetch and Agent. Reply with the exact names it found, comma-separated, or NONE.";
  const on = await turn("claude-code", {}, SEARCH, claudeModel);
  expect(on.text).toMatch(/WebSearch|WebFetch|\bAgent\b/);
  const off = await turn("claude-code", { "claude-code": { subagents: false, web: false } }, SEARCH, claudeModel);
  expect(off.text).not.toMatch(/WebSearch|WebFetch|\bAgent\b/);
}, 10 * 60_000);

smoke("Codex takes the switches as config: subagents and web search come and go", async () => {
  // Its web search is a hosted tool, not a function the model would name: it shows as a 「Search」 step.
  const SEARCH = "Search the web (not the shell) for today's top story on the OpenAI news page, and reply with its title and the source domain in one line.";
  const on = await turn("codex", { codex: { webSearch: "live" } }, LIST_TOOLS, codexSlug);
  expect(on.text).toMatch(/spawn_agent/);
  expect((await turn("codex", { codex: { webSearch: "live" } }, SEARCH, codexSearchModel)).tools).toContain("Search");
  const off = await turn("codex", { codex: { subagents: false, webSearch: "disabled" } }, LIST_TOOLS, codexSlug);
  expect(off.text).not.toMatch(/spawn_agent/);
  expect((await turn("codex", { codex: { webSearch: "disabled" } }, SEARCH, codexSearchModel)).tools).not.toContain("Search");
}, 10 * 60_000);

smoke("OpenCode gets web search and Vgent's memory by default", async () => {
  const listed = await turn("opencode", {}, LIST_TOOLS, openCodeModel);
  expect(listed.text).toMatch(/websearch/i);
  expect(listed.text).toMatch(/memory/i);
  const remembered = await turn("opencode", {}, "Call the memory tool with action list, then reply with exactly what it returned.", openCodeModel);
  expect(remembered.tools.some((tool) => /memory/i.test(tool))).toBe(true);
  expect(remembered.text).toContain("记忆为空");
  const without = await turn("opencode", { opencode: { memory: false, web: false, todos: false } }, LIST_TOOLS, openCodeModel);
  expect(without.text).not.toMatch(/websearch|memory|todowrite/i);
  // Subagents and web fetch stay in its list when switched off, but every call is refused.
  const called = await turn(
    "opencode",
    { opencode: { subagents: false, web: false } },
    "Call webfetch on https://example.com, then call the task tool to have a subagent list files. Report what each returned.",
    openCodeModel,
  );
  expect(called.tools.length).toBeGreaterThan(0);
  expect(called.refused).toEqual(called.tools);
}, 10 * 60_000);
