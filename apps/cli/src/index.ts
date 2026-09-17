#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgentTUI } from "@ai-sdk/tui";
import { connectMcpServers, createVgentEngine, loadSkillsIndex, parseMcpServers } from "@vgent/engine";
import { createClaudeCodeEngine, createCodexEngine, type TUIAgent } from "@vgent/engines";

const ENGINES = ["claude-code", "codex", "vgent"] as const;
const PERMISSION_MODES = ["allow-reads", "allow-edits", "allow-all"] as const;

const USAGE = `Usage: vgent --engine ${ENGINES.join("|")} [--repo <path>] [--permission ${PERMISSION_MODES.join("|")}]
             [--model <spec>] [--session <file>] [--mcp <file>]

--model, --session and --mcp apply to --engine vgent only. --model takes a
gateway "provider/model" spec, or "codex-subscription:<modelId>" to use this
machine's Codex CLI login. --session is a JSONL file the turn's messages are
appended to. --mcp is a JSON file holding an array of MCP server configs
({ name, command, args?, env? } or { name, url, transport? }).`;

const TITLES: Record<(typeof ENGINES)[number], string> = {
  "claude-code": "Vgent · Claude Code",
  codex: "Vgent · Codex",
  vgent: "Vgent",
};

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value == null) return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown --${name}: ${value}. Expected one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

const { values } = parseArgs({
  options: {
    engine: { type: "string" },
    repo: { type: "string" },
    permission: { type: "string" },
    model: { type: "string" },
    session: { type: "string" },
    mcp: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const engineName = pick("engine", values.engine, ENGINES, "claude-code");
// Codex has no built-in tool approval, so its only supported mode is
// `allow-all`; `createCodexEngine` already throws a clear error if an
// explicit `--permission` picks anything else.
const permissionMode = pick("permission", values.permission, PERMISSION_MODES, engineName === "codex" ? "allow-all" : "allow-edits");
const repoPath = resolve(values.repo ?? process.cwd());

if (engineName !== "vgent" && (values.model != null || values.session != null || values.mcp != null)) {
  throw new Error(`--model, --session and --mcp are only supported with --engine vgent, not --engine ${engineName}.`);
}

/** The skills this machine offers the agent: the repo's own first, then the user's. */
const skillDirs = [join(repoPath, ".claude", "skills"), join(homedir(), ".vgent", "skills")];

async function createEngine(): Promise<{ agent: TUIAgent; dispose(): Promise<void> }> {
  switch (engineName) {
    case "codex":
      return createCodexEngine({ repoPath, permissionMode });
    case "vgent": {
      if (values.model == null) {
        throw new Error('--engine vgent requires --model, e.g. --model codex-subscription:gpt-5.5.');
      }
      const mcp = await connectMcpServers(
        values.mcp == null ? [] : parseMcpServers(JSON.parse(await readFile(resolve(values.mcp), "utf8"))),
        { log: console },
      );
      const engine = createVgentEngine({
        model: values.model,
        repoPath,
        permissionMode,
        extraTools: mcp.tools,
        skills: await loadSkillsIndex(skillDirs),
        ...(values.session == null ? {} : { sessionFile: resolve(values.session) }),
      });
      return {
        agent: engine.agent,
        dispose: async () => {
          await mcp.close();
          await engine.dispose();
        },
      };
    }
    default:
      return createClaudeCodeEngine({ repoPath, permissionMode });
  }
}

const engine = await createEngine();
try {
  await runAgentTUI({
    title: TITLES[engineName],
    agent: engine.agent,
    tools: "auto-collapsed",
    reasoning: "collapsed",
  });
} finally {
  await engine.dispose();
}
