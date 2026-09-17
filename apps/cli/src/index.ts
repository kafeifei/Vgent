#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgentTUI } from "@ai-sdk/tui";
import { createVgentEngine } from "@vgent/engine";
import { createClaudeCodeEngine, createCodexEngine, type TUIAgent } from "@vgent/engines";

const ENGINES = ["claude-code", "codex", "vgent"] as const;
const PERMISSION_MODES = ["allow-reads", "allow-edits", "allow-all"] as const;

const USAGE = `Usage: vgent --engine ${ENGINES.join("|")} [--repo <path>] [--permission ${PERMISSION_MODES.join("|")}]
             [--model <spec>] [--session <file>]

--model and --session apply to --engine vgent only. --model takes a gateway
"provider/model" spec, or "codex-subscription:<modelId>" to use this machine's
Codex CLI login. --session is a JSONL file the turn's messages are appended to.`;

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

if (engineName !== "vgent" && (values.model != null || values.session != null)) {
  throw new Error(`--model and --session are only supported with --engine vgent, not --engine ${engineName}.`);
}

async function createEngine(): Promise<{ agent: TUIAgent; dispose(): Promise<void> }> {
  switch (engineName) {
    case "codex":
      return createCodexEngine({ repoPath, permissionMode });
    case "vgent": {
      if (values.model == null) {
        throw new Error('--engine vgent requires --model, e.g. --model codex-subscription:gpt-5.5.');
      }
      return createVgentEngine({
        model: values.model,
        repoPath,
        permissionMode,
        ...(values.session == null ? {} : { sessionFile: resolve(values.session) }),
      });
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
