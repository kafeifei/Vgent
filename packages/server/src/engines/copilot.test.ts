import { describe, expect, it, vi } from "vitest";
import type { CopilotModel } from "../accounts/copilot.js";
import { claudeCodeCopilotRoute } from "./claude-code.js";
import { codexCopilotRoute } from "./codex.js";
import { copilotRouteFor, type CopilotRoute } from "./copilot.js";
import { openCodeCopilotRoute } from "./opencode.js";

const MODELS: Record<string, CopilotModel> = {
  claude: { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", vendor: "anthropic", protocols: ["messages", "chat-completions"], reasoningLevels: ["low", "high"], contextWindow: 200_000, maxOutputTokens: 128_000 },
  gpt: { id: "gpt-6-luna", name: "GPT-6 Luna", vendor: "openai", protocols: ["responses"], reasoningLevels: ["none", "high"], contextWindow: 272_000, maxOutputTokens: 128_000 },
  gemini: { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", protocols: ["chat-completions"], reasoningLevels: [] },
};
const ENDPOINT = { baseURL: "http://127.0.0.1:5000/github-0a1b2c3d", apiKey: "relay-key" };
const accounts = { copilot: vi.fn(async (_account: string, model: string) => ({ ...ENDPOINT, model: Object.values(MODELS).find((entry) => entry.id === model)! })) };

describe("copilotRouteFor", () => {
  it("takes a Copilot model to the relay on the protocol the engine speaks, and leaves every other model alone", async () => {
    const claudeCode = { id: "claude-code" as const, label: "Claude Code" };
    expect(await copilotRouteFor(claudeCode, { spec: "sonnet" }, accounts)).toBeUndefined();
    expect(await copilotRouteFor(claudeCode, { accountId: "github-0a1b2c3d", spec: "github-copilot:claude-sonnet-5.5" }, accounts)).toEqual({ ...ENDPOINT, model: MODELS.claude, protocol: "messages" });
    expect(accounts.copilot).toHaveBeenLastCalledWith("github-0a1b2c3d", "claude-sonnet-5.5");
    // The first GitHub account when the spec names none.
    await copilotRouteFor({ id: "codex", label: "Codex" }, { spec: "github-copilot:gpt-6-luna" }, accounts);
    expect(accounts.copilot).toHaveBeenLastCalledWith("github", "gpt-6-luna");
    await expect(copilotRouteFor({ id: "codex", label: "Codex" }, { spec: "github-copilot:claude-sonnet-5.5" }, accounts)).rejects.toThrow("Codex 跑不了 Copilot 的 Claude Sonnet 5.5");
    await expect(copilotRouteFor(claudeCode, { spec: "github-copilot:gpt-6-luna" }, undefined)).rejects.toThrow("不可用");
  });
});

describe("Copilot on the engines that run as processes", () => {
  const route = (key: keyof typeof MODELS, protocol: CopilotRoute["protocol"]): CopilotRoute => ({ ...ENDPOINT, model: MODELS[key]!, protocol });

  it("gives Claude Code the relay as its Anthropic endpoint and Copilot's prompt limit as its window", () => {
    const routed = claudeCodeCopilotRoute(route("claude", "messages"));
    expect(routed).toMatchObject({ model: "claude-sonnet-5.5", contextWindow: 200_000, auth: { ANTHROPIC_BASE_URL: ENDPOINT.baseURL, ANTHROPIC_AUTH_TOKEN: "relay-key" } });
    expect(routed.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-sonnet-5.5");
  });

  it("gives Codex the relay as its Responses endpoint and Copilot's prompt limit as its window", () => {
    expect(codexCopilotRoute(route("gpt", "responses"))).toEqual({
      model: "gpt-6-luna",
      auth: { OPENAI_BASE_URL: ENDPOINT.baseURL, OPENAI_API_KEY: "relay-key" },
      codexConfig: { model_context_window: 272_000 },
    });
  });

  it("gives OpenCode a provider of its own per protocol, never its built-in github-copilot", () => {
    const provider = (routed: ReturnType<typeof openCodeCopilotRoute>) => (routed.provider as Record<string, Record<string, unknown>>)["vgent-github-copilot"];
    const claude = openCodeCopilotRoute(route("claude", "messages"), { reasoning: true });
    expect(claude.model).toBe("vgent-github-copilot/claude-sonnet-5.5");
    expect(provider(claude)).toEqual({
      npm: "@ai-sdk/anthropic",
      name: "GitHub Copilot",
      options: { baseURL: `${ENDPOINT.baseURL}/v1`, apiKey: "relay-key" },
      models: { "claude-sonnet-5.5": { name: "Claude Sonnet 5.5", reasoning: true, limit: { context: 200_000, output: 128_000 } } },
    });
    const gpt = provider(openCodeCopilotRoute(route("gpt", "responses"), { contextWindow: 100_000 }));
    expect(gpt).toMatchObject({ npm: "@ai-sdk/openai", options: { baseURL: ENDPOINT.baseURL, apiKey: "relay-key" } });
    // The task's own window over Copilot's; and Copilot keeps no Responses state to point back at.
    expect(gpt?.models).toEqual({ "gpt-6-luna": { name: "GPT-6 Luna", limit: { context: 100_000, output: 128_000 }, options: { store: false } } });
    const gemini = provider(openCodeCopilotRoute(route("gemini", "chat-completions")));
    expect(gemini).toMatchObject({ npm: "@ai-sdk/openai-compatible", options: { baseURL: ENDPOINT.baseURL, apiKey: "relay-key", includeUsage: true } });
    expect(gemini?.models).toEqual({ "gemini-3.8-flash": { name: "Gemini 3.8 Flash" } });
  });
});
