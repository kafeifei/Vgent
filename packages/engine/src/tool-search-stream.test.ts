import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToModelMessages, isToolUIPart, readUIMessageStream, type UIMessage } from "ai";
import { createCodexSubscriptionModel, createModelRegistry, type ProviderConfig } from "@vgent/providers";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVgentEngine } from "./engine.js";

const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const loadedTool = { type: "function", name: "srv__tool", description: "Search records", parameters: schema, strict: true, defer_loading: true };
const searchCall = { type: "tool_search_call", id: "ts_1", execution: "server", call_id: null, status: "completed", arguments: { query: "records" } };
const searchOutput = { type: "tool_search_output", id: "tso_1", execution: "server", call_id: null, status: "completed", tools: [loadedTool] };
const functionCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "srv__tool", arguments: '{"query":"records"}', status: "completed" };
const user: UIMessage = { id: "user_1", role: "user", parts: [{ type: "text", text: "Find records" }] };
type Item = Record<string, unknown>;
type Body = { tools: Item[]; input: Item[]; store?: boolean };

// Wire events go through the real OpenAI Responses SSE parser, not a mock model.
function sse(search: boolean): Response {
  const events: Item[] = [];
  const items = search ? [searchCall, searchOutput, functionCall] : [{ type: "message", id: "msg_1" }];
  items.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item });
    if (item.type === "message") {
      events.push({ type: "response.output_text.delta", item_id: item.id, output_index, delta: "Done" });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(store: boolean, permissionMode: "allow-all" | "allow-reads" = "allow-all") {
  const repoPath = await mkdtemp(join(tmpdir(), "vgent-tool-search-stream-"));
  cleanup.push(() => rm(repoPath, { recursive: true, force: true }));
  const bodies: Body[] = [];
  const execute = vi.fn(async ({ query }: { query: string }) => ({ records: [query] }));
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    if (bodies.length > 3) throw new Error("Unexpected extra model invocation");
    return sse(bodies.length === 1);
  };
  const providers: ProviderConfig[] = [{
    id: "custom-official", name: "Official OpenAI", apiKey: "fake-offline-key",
    agents: { vgent: { protocol: "openai", baseURL: "https://api.openai.com/v1", models: [] } },
  }];
  const model = store
    ? createModelRegistry({ providers, fetch }).languageModel("custom-official:gpt-6-astra")
    : createCodexSubscriptionModel("gpt-6-astra", { accessToken: "fake-offline-token", fetch });
  const rebuild = () => {
    const engine = createVgentEngine({
      model, providers, repoPath, outputDir: join(repoPath, "output"), permissionMode, subagents: false, sessionId: "tool-search-regression",
      extraTools: {
        srv__tool: { description: "Search records", inputSchema: z.object({ query: z.string() }), deferLoading: true, execute },
      },
    });
    cleanup.push(engine.dispose);
    return engine;
  };
  return { bodies, execute, rebuild };
}

async function uiTurn(engine: ReturnType<typeof createVgentEngine>, history: UIMessage[]) {
  const result = await engine.agent.stream({ messages: await convertToModelMessages(history, { tools: engine.agent.tools }) });
  let saved: UIMessage | undefined;
  const last = history.at(-1);
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream({ originalMessages: history }),
    ...(last?.role === "assistant" ? { message: last } : {}),
    terminateOnError: true,
  })) saved = message;
  expect(saved).toBeDefined();
  // Simulate the JSON storage boundary used by UI conversation history.
  return JSON.parse(JSON.stringify(saved)) as UIMessage;
}

function stableTools(bodies: Body[], store: boolean) {
  expect(bodies[0]!.tools).toContainEqual(expect.objectContaining({ type: "tool_search" }));
  expect(bodies[0]!.tools).toContainEqual(expect.objectContaining({ name: "srv__tool", defer_loading: true, parameters: expect.objectContaining(schema) }));
  for (const body of bodies) {
    expect(body.tools).toEqual(bodies[0]!.tools);
    if (store) expect(body.store).toBeUndefined(); // OpenAI defaults to store: true.
    else {
      expect(body.store).toBe(false);
      expect(body.input.some((item) => item.type === "item_reference")).toBe(false);
    }
  }
}

function replayedSearch(body: Body, store: boolean) {
  if (store) {
    expect(body.input).toEqual(expect.arrayContaining([
      { type: "item_reference", id: "ts_1" },
      { type: "item_reference", id: "tso_1" },
    ]));
  } else {
    expect(body.input.filter((item) => item.type === "tool_search_call")).toEqual([
      expect.objectContaining({ arguments: searchCall.arguments, execution: "server" }),
    ]);
    expect(body.input.filter((item) => item.type === "tool_search_output")).toEqual([
      expect.objectContaining({ tools: [loadedTool], execution: "server" }),
    ]);
  }
  // The SDK always replays local function calls so call_id pairs remain intact.
  expect(body.input.filter((item) => item.type === "function_call")).toEqual([
    expect.objectContaining({ call_id: "call_1", name: "srv__tool", arguments: functionCall.arguments }),
  ]);
}

describe.each([
  { name: "Codex store:false", store: false },
  { name: "official OpenAI default store:true", store: true },
])("hosted tool search through Responses SSE and UI history: $name", ({ store }) => {
  it("keeps the tools prefix stable and appends search schemas and local results to input", async () => {
    const { bodies, execute, rebuild } = await fixture(store);
    const saved = await uiTurn(rebuild(), [user]);
    expect(saved.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Done" }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ query: "records" });
    expect(bodies).toHaveLength(2);
    stableTools(bodies, store);
    replayedSearch(bodies[1]!, store);
    expect(bodies[1]!.input.slice(0, bodies[0]!.input.length)).toEqual(bodies[0]!.input);
    expect(bodies[1]!.input.map((item) => item.type).filter(Boolean)).toEqual(store ? [
      "item_reference", "item_reference", "function_call", "function_call_output",
    ] : [
      "tool_search_call", "tool_search_output", "function_call", "function_call_output",
    ]);
    expect(bodies[1]!.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: JSON.stringify({ records: ["records"] }) }));
  });

  it("restores hosted search context after UI persistence and engine reconstruction without re-execution", async () => {
    const { bodies, execute, rebuild } = await fixture(store);
    const engine = rebuild();
    const saved = await uiTurn(engine, [user]);
    const search = saved.parts.filter(isToolUIPart).find((part) => part.toolCallId === "ts_1");
    expect(search).toMatchObject({ providerExecuted: true, state: "output-available", output: { tools: [loadedTool] } });
    await engine.dispose();
    const next = await uiTurn(rebuild(), [user, saved, { id: "user_2", role: "user", parts: [{ type: "text", text: "Continue" }] }]);
    expect(next.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Done" }));
    expect(bodies).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(1);
    stableTools(bodies, store);
    replayedSearch(bodies[2]!, store);
    expect(bodies[2]!.input.slice(0, bodies[1]!.input.length)).toEqual(bodies[1]!.input);
    if (store) {
      expect(bodies[2]!.input).toContainEqual({ type: "item_reference", id: "msg_1" });
    } else {
      expect(bodies[2]!.input.filter((item) => item.type)).toEqual(bodies[1]!.input.filter((item) => item.type));
    }
    expect(bodies[2]!.input.filter((item) => item.type === "function_call_output")).toHaveLength(1);
  });

  it.each([undefined, false])("preserves legacy generic search history, providerExecuted=%s", async (providerExecuted) => {
    const { bodies, execute, rebuild } = await fixture(store);
    const legacy: UIMessage = {
      id: "legacy_assistant", role: "assistant", parts: [{
        type: "tool-toolSearch", toolCallId: "legacy_search", state: "output-available",
        input: { query: "records" }, output: { tools: [{ name: "srv__tool", description: "Search records" }] },
        ...(providerExecuted === undefined ? {} : { providerExecuted }),
      }],
    };
    const saved = await uiTurn(rebuild(), [user, legacy, {
      id: "user_2", role: "user", parts: [{ type: "text", text: "Continue" }],
    }]);
    expect(saved.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Done" }));
    expect(saved.parts.filter(isToolUIPart).find((part) => part.toolCallId === "ts_1")).toMatchObject({
      type: "tool-tool_search", providerExecuted: true, state: "output-available", output: { tools: [loadedTool] },
    });
    expect(bodies).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toEqual({ query: "records" });
    stableTools(bodies, store);
    for (const body of bodies) {
      expect(body.input.filter((item) => item.call_id === "legacy_search")).toEqual([
        expect.objectContaining({ type: "function_call", name: "toolSearch", arguments: JSON.stringify({ query: "records" }) }),
        expect.objectContaining({ type: "function_call_output", output: JSON.stringify({ tools: [{ name: "srv__tool", description: "Search records" }] }) }),
      ]);
      expect(body.input.filter((item) => item.type === "tool_search_call" || item.type === "tool_search_output")
        .some((item) => item.call_id === "legacy_search" || item.id === "legacy_search")).toBe(false);
    }
    // Check the new hosted call separately from the legacy generic function call.
    replayedSearch({ ...bodies[1]!, input: bodies[1]!.input.filter((item) => item.call_id !== "legacy_search") }, store);
    expect(bodies[1]!.input).toContainEqual(expect.objectContaining({
      type: "function_call_output", call_id: "call_1", output: JSON.stringify({ records: ["records"] }),
    }));
  });

  it.each([true, false])("requires streamed approval for unknown MCP tools, approved=%s", async (approved) => {
    const { bodies, execute, rebuild } = await fixture(store, "allow-reads");
    const engine = rebuild();
    const saved = await uiTurn(engine, [user]);
    const pending = saved.parts.filter(isToolUIPart).filter((part) => part.state === "approval-requested");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ toolCallId: "call_1", approval: { id: expect.any(String) } });
    expect(execute).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    saved.parts = saved.parts.map((part) => isToolUIPart(part) && part.state === "approval-requested"
      ? { ...part, state: "approval-responded", approval: { ...part.approval, approved } }
      : part);
    await uiTurn(rebuild(), [user, saved]);
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(bodies).toHaveLength(2);
    stableTools(bodies, store);
    replayedSearch(bodies[1]!, store);
    const outputs = bodies[1]!.input.filter((item) => item.type === "function_call_output");
    expect(outputs).toHaveLength(1);
    if (approved) expect(outputs[0]!.output).toBe(JSON.stringify({ records: ["records"] }));
    else expect(outputs[0]!.output).not.toContain("records");
  });
});
