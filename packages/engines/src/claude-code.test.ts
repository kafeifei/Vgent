import { describe, expect, it } from "vitest";
import { defaultClaudeCodeAuth } from "./claude-code.js";

describe("defaultClaudeCodeAuth", () => {
  /**
   * The whole point of supplying an environment instead of `auth: 'auto'`: a
   * forwarded OAuth token is resolved once and then goes stale inside a bridge
   * that outlives it, which is what turned a parked approval into a 401. The
   * `claude` CLI in the bridge refreshes the machine's login itself.
   */
  it("never forwards the subscription OAuth token, even when the process has one", () => {
    const env = defaultClaudeCodeAuth({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-expiring-soon",
      HOME: "/Users/someone",
      PATH: "/usr/bin",
    });
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(env)).not.toContain("sk-ant-oat01-expiring-soon");
    expect(env).toEqual({});
  });

  it("forwards the API key, gateway and base-url variables a non-subscription user sets", () => {
    expect(
      defaultClaudeCodeAuth({
        ANTHROPIC_API_KEY: "sk-ant-api-key",
        ANTHROPIC_AUTH_TOKEN: "bearer-token",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        AI_GATEWAY_API_KEY: "gw-key",
        AI_GATEWAY_BASE_URL: "https://gateway.example",
        VERCEL_OIDC_TOKEN: "oidc",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-expiring-soon",
        // Not a credential variable: it must not leak into the auth object.
        npm_config_registry: "https://registry.example",
      }),
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-api-key",
      ANTHROPIC_AUTH_TOKEN: "bearer-token",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      AI_GATEWAY_API_KEY: "gw-key",
      AI_GATEWAY_BASE_URL: "https://gateway.example",
      VERCEL_OIDC_TOKEN: "oidc",
    });
  });

  it("drops variables that are set but empty, so the adapter does not see a blank credential", () => {
    expect(defaultClaudeCodeAuth({ ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "https://proxy.example" })).toEqual({
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
  });
});
