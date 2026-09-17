import { describe, expect, it } from "vitest";
import type { CodexAccessToken } from "./codex-credentials.js";
import { CHATGPT_CODEX_BASE_URL } from "./codex-credentials.js";
import { createCodexFetch, prepareCodexResponsesBody } from "./codex-fetch.js";

const RESPONSES_URL = `${CHATGPT_CODEX_BASE_URL}/responses`;

function stubTokens(tokens: readonly Partial<CodexAccessToken>[]) {
  const calls: { forceRefresh: boolean }[] = [];
  let index = 0;
  return {
    calls,
    provider: {
      getAccessToken: async ({ forceRefresh = false } = {}) => {
        calls.push({ forceRefresh });
        const token = tokens[Math.min(index, tokens.length - 1)];
        index += 1;
        return {
          accessToken: "token-a",
          accountId: "acct-123",
          expiresAt: Date.now() + 3_600_000,
          source: "file" as const,
          ...token,
        };
      },
    },
  };
}

function sse(...events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("prepareCodexResponsesBody", () => {
  it("forces a stateless stream and reports whether the caller wanted one", () => {
    const generate = prepareCodexResponsesBody(
      JSON.stringify({ model: "gpt-5.5", input: [], max_output_tokens: 100 }),
    );
    expect(generate.stream).toBe(false);
    const body = JSON.parse(generate.body) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.include).toEqual(["reasoning.encrypted_content"]);

    const streamed = prepareCodexResponsesBody(JSON.stringify({ model: "gpt-5.5", input: [], stream: true }));
    expect(streamed.stream).toBe(true);
  });

  it("hoists leading system and developer turns into instructions", () => {
    const { body } = prepareCodexResponsesBody(
      JSON.stringify({
        instructions: "base",
        input: [
          { role: "system", content: "sys" },
          { role: "developer", content: [{ type: "input_text", text: "dev" }] },
          { role: "user", content: [{ type: "input_text", text: "hi" }] },
          { role: "system", content: "not hoisted" },
        ],
      }),
    );
    const parsed = JSON.parse(body) as { instructions: string; input: { role: string }[] };
    expect(parsed.instructions).toBe("base\n\nsys\n\ndev");
    expect(parsed.input.map((item) => item.role)).toEqual(["user", "system"]);
  });

  it("strips ids from encrypted reasoning items and relaxes function tool strictness", () => {
    const { body } = prepareCodexResponsesBody(
      JSON.stringify({
        input: [
          { type: "reasoning", id: "rs_1", encrypted_content: "abc" },
          { type: "reasoning", id: "rs_2" },
        ],
        tools: [{ type: "function", name: "read", strict: true }, { type: "web_search" }],
      }),
    );
    const parsed = JSON.parse(body) as { input: Record<string, unknown>[]; tools: Record<string, unknown>[] };
    expect(parsed.input[0]).toEqual({ type: "reasoning", encrypted_content: "abc" });
    expect(parsed.input[1]).toHaveProperty("id", "rs_2");
    expect(parsed.tools[0]).toMatchObject({ type: "function", strict: null });
    expect(parsed.tools[1]).toEqual({ type: "web_search" });
  });
});

describe("createCodexFetch", () => {
  it("injects the bearer token and account header and drops x-api-key", async () => {
    let seen: Headers | undefined;
    const { provider } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async (_input, init) => {
        seen = new Headers(init?.headers);
        return sse({ type: "response.completed", response: { id: "resp_1", output: [] } });
      },
    });
    await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { "x-api-key": "sk-should-be-removed", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", input: [] }),
    });
    expect(seen?.get("authorization")).toBe("Bearer token-a");
    expect(seen?.get("chatgpt-account-id")).toBe("acct-123");
    expect(seen?.get("originator")).toBe("codex_cli_rs");
    expect(seen?.get("openai-beta")).toBe("responses=experimental");
    expect(seen?.get("accept")).toBe("text/event-stream");
    expect(seen?.has("x-api-key")).toBe(false);
  });

  it("refuses to send credentials to any other host", async () => {
    const { provider, calls } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async () => new Response("{}"),
    });
    await expect(fetch("https://example.com/responses", { method: "POST" })).rejects.toThrow(
      /Refusing to send Codex credentials/,
    );
    expect(calls).toHaveLength(0);
  });

  it("retries once with a refreshed token on 401", async () => {
    const { provider, calls } = stubTokens([{ accessToken: "stale" }, { accessToken: "fresh" }]);
    const authorizations: (string | null)[] = [];
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorizations.push(headers.get("authorization"));
        return authorizations.length === 1
          ? new Response("{\"error\":\"expired\"}", { status: 401 })
          : sse({ type: "response.completed", response: { id: "resp_2", output: [] } });
      },
    });
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: [] }),
    });
    expect(response.status).toBe(200);
    expect(authorizations).toEqual(["Bearer stale", "Bearer fresh"]);
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it("folds the forced stream back into a single JSON body, rebuilding the empty output array", async () => {
    const { provider } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async () =>
        sse(
          { type: "response.created", response: { id: "resp_3" } },
          { type: "response.output_item.done", output_index: 1, item: { type: "message", text: "OK" } },
          { type: "response.output_item.done", output_index: 0, item: { type: "reasoning" } },
          { type: "response.output_text.delta", delta: "OK" },
          // This endpoint always reports `output: []` on the terminal event.
          { type: "response.completed", response: { id: "resp_3", status: "completed", output: [] } },
        ),
    });
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: [] }),
    });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      id: "resp_3",
      status: "completed",
      output: [{ type: "reasoning" }, { type: "message", text: "OK" }],
    });
  });

  it("keeps a non-empty output array from the terminal event", async () => {
    const { provider } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async () =>
        sse({ type: "response.done", response: { id: "resp_5", output: [{ type: "message" }] } }),
    });
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: [] }),
    });
    expect(await response.json()).toEqual({ id: "resp_5", output: [{ type: "message" }] });
  });

  it("renames response.done to response.completed when streaming through", async () => {
    const { provider } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async () => sse({ type: "response.done", response: { id: "resp_4" } }),
    });
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: [], stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain("response.done");
    expect(text).toContain("data: [DONE]");
  });

  it("passes an error body through with its status", async () => {
    const { provider } = stubTokens([{}]);
    const fetch = createCodexFetch({
      tokens: provider,
      fetch: async () =>
        new Response(JSON.stringify({ detail: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    const response = await fetch(RESPONSES_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.5", input: [] }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("forbidden");
  });
});
