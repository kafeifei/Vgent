import { describe, expect, it, vi } from "vitest";
import { createAccountService } from "./service.js";
import { createCopilotAccess } from "./copilot.js";
import { parseClaudeUsage, parseCodexUsage, parseCopilotUsage } from "./usage.js";
import type { RemoteService } from "../remote/service.js";

const signedOutCodex = async () => ({ codex: { available: false, source: null } });
function remoteFixture() {
  let loggedIn = true, revision = 0;
  return {
    getState: async () => ({ account: loggedIn ? { username: "example", name: "Example" } : null }),
    githubAccess: async () => { if (!loggedIn) throw new Error("signed out"); return { accessToken: "one-github-login", accountId: "123", revision }; },
    logout: async () => { loggedIn = false; revision++; },
  };
}

describe("quota adapters", () => {
  it("keeps missing data unknown, preserves real zeros and never invents reset dates", () => {
    expect(parseCodexUsage({}).status).toBe("unavailable");
    const codex = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 2000000000 } } });
    expect(codex.windows[0]).toMatchObject({ usedPercent: 0, label: "5 小时", resetsAt: new Date(2000000000000).toISOString() });
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: 31, resets_at: null } }).windows).toEqual([{ id: "seven_day", label: "每周", usedPercent: 31 }]);
    expect(parseCopilotUsage({ quota_snapshots: { chat: { unlimited: true } } }).windows).toEqual([{ id: "chat", label: "聊天", unlimited: true }]);
  });
  it("maps model-specific windows, extra spending and AI credits without double counting", () => {
    const claude = parseClaudeUsage({ seven_day_opus: { utilization: 65 }, extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 1000, utilization: 25 } });
    expect(claude.windows[1]).toMatchObject({ used: 2.5, limit: 10, unit: "USD" });
    const copilot = parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: 72, credits_used: 40 }, chat: { unlimited: true, credits_used: 40 } } });
    expect(copilot.windows[0]?.usedPercent).toBe(28);
    expect(copilot.windows.filter(w => w.id === "ai-credits")).toHaveLength(1);
  });
});

describe("single account service", () => {
  it("coalesces concurrent reads, shares the remote login and projects no secrets", async () => {
    const remote = remoteFixture();
    const probe = vi.fn(async () => ({ loggedIn: false }));
    const fetcher = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer one-github-login");
      return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 80 } } });
    }) as unknown as typeof fetch;
    const service = createAccountService({ remote: remote as unknown as RemoteService, probeClaude: probe, probeCodex: signedOutCodex, fetch: fetcher });
    const [a, b] = await Promise.all([service.list({ usage: true }), service.list({ usage: true })]);
    expect(a).toBe(b); expect(probe).toHaveBeenCalledTimes(1);
    expect(a.accounts[0]?.usage?.windows[0]?.usedPercent).toBe(20);
    expect(JSON.stringify(a)).not.toContain("one-github-login");
  });
  it("discards an in-flight usage result after logout", async () => {
    const remote = remoteFixture();
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const service = createAccountService({ remote: remote as unknown as RemoteService, probeClaude: async () => ({ loggedIn: false }), probeCodex: signedOutCodex, fetch: async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ quota_snapshots: { chat: { unlimited: true } } });
    } });
    const pending = service.list({ usage: true });
    await ready; await service.change("github", remote.logout); finish();
    const result = await pending;
    expect(result.accounts[0]).toMatchObject({ loggedIn: false });
    expect(result.accounts[0]?.usage).toBeUndefined();
  });
  it("does not read subscription credentials for a Claude API-key login", async () => {
    const token = vi.fn();
    const service = createAccountService({ probeClaude: async () => ({ loggedIn: true, method: "api_key" }), probeCodex: signedOutCodex, claudeToken: token });
    const result = await service.list({ usage: true });
    expect(result.accounts[2]?.method).toBe("api_key"); expect(token).not.toHaveBeenCalled();
  });
});

describe("Copilot model access", () => {
  it("derives model access from the same GitHub login and rejects calls after logout", async () => {
    const remote = remoteFixture(), sent: { url: string; authorization: string | null }[] = [];
    const access = createCopilotAccess(remote.githubAccess, async (input, init) => {
      const url = String(input), authorization = new Headers(init?.headers).get("Authorization");
      sent.push({ url, authorization });
      if (url.endsWith("/token")) return Response.json({ token: "derived", expires_at: Date.now() / 1000 + 600 });
      if (url.endsWith("/models")) return Response.json({ data: [
        { id: "usable", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/chat/completions"] },
        { id: "responses-only", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/responses"] },
      ] });
      return Response.json({ id: "fixture", created: 1, model: "usable", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    const models = await access.models();
    expect(models.map(m => m.id)).toEqual(["github-copilot:usable", "github-copilot:responses-only"]);
    const { generateText } = await import("ai");
    const result = await generateText({ model: await access.model("usable"), prompt: "test", maxRetries: 0 });
    expect(result.text).toBe("ok");
    expect(sent[0]?.authorization).toBe("Bearer one-github-login");
    expect(sent.at(-1)?.authorization).toBe("Bearer derived");
    expect(sent.at(-1)?.url).toBe("https://api.githubcopilot.com/chat/completions");
    await remote.logout();
    await expect(access.available()).rejects.toThrow("signed out");
  });
});

it("identity-only reads retain quotas without postponing their next refresh", async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const fetcher = vi.fn(async () => Response.json({ copilot_plan: "individual", quota_snapshots: { chat: { unlimited: true } } }));
    const service = createAccountService({ remote: remoteFixture() as unknown as RemoteService, probeClaude: async () => ({ loggedIn: false }), probeCodex: signedOutCodex, fetch: fetcher });
    const full = await service.list({ usage: true });
    now += 61_000;
    const identity = await service.list();
    expect(identity.accounts[0]?.usage).toBe(full.accounts[0]?.usage);
    expect(identity.accounts[0]?.plan).toBe("individual");
    await service.list({ usage: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it("executes Responses-only Copilot models, including a tool continuation, using the same login", async () => {
  const bodies: Record<string, unknown>[] = [], initiators: (string | null)[] = [];
  const access = createCopilotAccess(remoteFixture().githubAccess, async (input, init) => {
    const url = String(input);
    if (url.endsWith("/token")) return Response.json({ token: "derived", expires_at: Date.now() / 1000 + 600 });
    if (url.endsWith("/models")) return Response.json({ data: [
      { id: "responses-only", capabilities: { type: "chat", supports: { tool_calls: true } }, supported_endpoints: ["/responses"] },
      { id: "disabled", capabilities: { type: "chat", supports: { tool_calls: true } }, policy: { state: "disabled" }, supported_endpoints: ["/responses"] },
    ] });
    expect(url).toBe("https://api.githubcopilot.com/responses");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer derived");
    bodies.push(JSON.parse(String(init?.body)));
    initiators.push(new Headers(init?.headers).get("X-Initiator"));
    const output = bodies.length === 1
      ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}", status: "completed" }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }];
    return Response.json({ id: `resp_${bodies.length}`, created_at: 1, model: "responses-only", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  });
  const { generateText, tool, jsonSchema, stepCountIs } = await import("ai");
  const result = await generateText({ model: await access.model("responses-only"), prompt: "read it", maxRetries: 0,
    tools: { read: tool({ inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => "file contents" }) }, stopWhen: stepCountIs(2) });
  expect(result.text).toBe("ok");
  expect(bodies.map(b => b.store)).toEqual([false, false]);
  expect(initiators).toEqual(["user", "agent"]);
  expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "file contents" }));
  await expect(access.model("disabled")).rejects.toThrow("unavailable");
});
