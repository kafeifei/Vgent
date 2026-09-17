#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAgentTUI } from "@ai-sdk/tui";
import { createClaudeCodeEngine } from "@vgent/engines";

const ENGINES = ["claude-code"] as const;
const PERMISSION_MODES = ["allow-reads", "allow-edits", "allow-all"] as const;

const USAGE = `Usage: vgent --engine claude-code [--repo <path>] [--permission ${PERMISSION_MODES.join("|")}]`;

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
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

pick("engine", values.engine, ENGINES, "claude-code");
const permissionMode = pick("permission", values.permission, PERMISSION_MODES, "allow-edits");
const repoPath = resolve(values.repo ?? process.cwd());

const engine = await createClaudeCodeEngine({ repoPath, permissionMode });
try {
  await runAgentTUI({
    title: "Vgent · Claude Code",
    agent: engine.agent,
    tools: "auto-collapsed",
    reasoning: "collapsed",
  });
} finally {
  await engine.dispose();
}
