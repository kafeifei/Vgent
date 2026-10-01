import { describe, expect, it } from "vitest";
import { ENGINE_OPTION_DEFAULTS, engineOptionsOf, readEngineOptions } from "./engine-options.js";
import { claudeCodeSwitches } from "./engines/claude-code.js";
import { codexSwitches } from "./engines/codex.js";
import { openCodeMcpServers, openCodeSwitches } from "./engines/opencode.js";

describe("engine options", () => {
  it("lays the user's overrides over each engine's defaults, and drops what an engine does not have", () => {
    const settings = {
      engineOptions: {
        codex: { memory: false, lsp: true, webSearch: "live" },
        vgent: { todos: "no", subagents: false },
        nope: { memory: false },
      },
    } as never;
    expect(engineOptionsOf(settings, "codex")).toEqual({ subagents: true, memory: false, webSearch: "live" });
    expect(engineOptionsOf(settings, "vgent")).toEqual({ subagents: false, memory: true, todos: true });
    expect(engineOptionsOf({}, "opencode")).toEqual(ENGINE_OPTION_DEFAULTS.opencode);
    expect(readEngineOptions({ codex: { webSearch: "sometimes" }, vgent: {} })).toEqual({});
  });

  it("turns Claude Code's switches into excluded tools and CLI environment", () => {
    expect(claudeCodeSwitches(ENGINE_OPTION_DEFAULTS["claude-code"])).toEqual({
      inactiveTools: [],
      // On by default: newer models only get a to-do list when asked, and `TodoWrite` is what the 计划 tab draws.
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "0" },
    });
    expect(claudeCodeSwitches({ subagents: false, memory: false, todos: false, web: false })).toEqual({
      inactiveTools: ["Agent", "webSearch", "WebFetch", "TodoWrite", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"],
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    });
  });

  it("turns Codex's switches into dotted config overrides that leave the rest of [features] alone", () => {
    expect(codexSwitches(ENGINE_OPTION_DEFAULTS.codex)).toEqual({ "agents.enabled": true, "features.multi_agent": true, "features.memories": true, web_search: "cached" });
    expect(codexSwitches({ subagents: false, memory: false, webSearch: "disabled" })).toEqual({
      "agents.enabled": false,
      "features.multi_agent": false,
      "features.memories": false,
      web_search: "disabled",
    });
  });

  it("turns OpenCode's switches into refused tools, its search flag and its LSP config", () => {
    expect(openCodeSwitches(ENGINE_OPTION_DEFAULTS.opencode)).toEqual({ inactiveTools: [], env: { OPENCODE_ENABLE_EXA: "1" }, config: { lsp: true } });
    expect(openCodeSwitches({ subagents: false, memory: false, todos: false, web: false, lsp: false })).toEqual({
      inactiveTools: ["agent", "webfetch"],
      env: {},
      // Out of the model's tool list: the bridge's own refusal never catches `todowrite`.
      config: { lsp: false, tools: { todowrite: false } },
    });
  });

  it("hands OpenCode the settings page's MCP servers in its own format", () => {
    expect(
      openCodeMcpServers([
        { name: "files", command: "npx", args: ["-y", "server-files"], env: { ROOT: "/tmp" } },
        { name: "docs", url: "https://example.test/mcp", transport: "http" },
      ]),
    ).toEqual({
      files: { type: "local", command: ["npx", "-y", "server-files"], environment: { ROOT: "/tmp" }, enabled: true },
      docs: { type: "remote", url: "https://example.test/mcp", enabled: true },
    });
  });
});
