import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareCodexSpeedCatalog } from "../codex-catalog.js";
import { CodexAppServer } from "./codex-app-server.js";

// Full runtime metadata, rather than the menu projection. No real model is called.
const model = {
  slug: "gpt-6-astra", display_name: "Test model", description: "Local fixture",
  default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
  shell_type: "unified_exec", visibility: "list", supported_in_api: true, priority: 1,
  additional_speed_tiers: ["fast", "ultrafast"],
  service_tiers: [{ id: "priority", name: "Fast", description: "Fast" }, { id: "ultrafast", name: "Ultrafast", description: "Ultrafast" }],
  base_instructions: "Reply OK.", support_verbosity: false, default_verbosity: "low",
  apply_patch_tool_type: "freeform", truncation_policy: { mode: "tokens", limit: 10000 },
  context_window: 272000, effective_context_window_percent: 95, input_modalities: ["text"], experimental_supported_tools: [],
};

it("sends Fast and Ultrafast on the wire and clears the tier after a process resumes the thread", async () => {
  const home = await mkdtemp(join(tmpdir(), "vgent-speed-wire-"));
  const received: unknown[] = [];
  const endpoint = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    received.push(body.service_tier ?? null);
    const id = String(received.length);
    const message = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    const result = { id: `resp_${id}`, object: "response", created_at: 1, model: model.slug, status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: result },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const port = (endpoint.address() as { port: number }).port;
  let server: CodexAppServer | undefined;
  const snapshot = await prepareCodexSpeedCatalog(home, model.slug, "ultrafast", { env: { CODEX_HOME: home }, fetchCatalog: async () => [model] });
  try {
    let threadId: string | undefined;
    for (const tier of ["priority", "ultrafast", null]) {
      server = new CodexAppServer({ cwd: home, env: { ...process.env, CODEX_HOME: home, VGENT_SPEED_TEST_KEY: "dummy" }, ...(tier != null ? { modelCatalogPath: snapshot.path } : {}) });
      await server.initialize();
      const warnings: unknown[] = [];
      let completed!: (value: Record<string, unknown>) => void;
      const done = new Promise<Record<string, unknown>>((resolve) => { completed = resolve; });
      server.onNotification((event) => {
        if (event.method === "turn/completed") completed(event.params.turn as Record<string, unknown>);
        if (event.method === "warning") warnings.push(event.params.message);
      });
      const params = {
        cwd: home, model: model.slug, sandbox: "danger-full-access", approvalPolicy: "never",
        config: { model_provider: "local_fixture", ...(tier != null ? { service_tier: tier } : {}), model_providers: { local_fixture: { name: "Test", base_url: `http://127.0.0.1:${port}/v1`, env_key: "VGENT_SPEED_TEST_KEY", wire_api: "responses", supports_websockets: false } } },
      };
      const result = threadId == null ? await server.request("thread/start", params) : await server.request("thread/resume", { ...params, threadId });
      threadId = (result.thread as { id: string }).id;
      await server.request("turn/start", { threadId, input: [{ type: "text", text: "Reply OK." }], serviceTier: tier });
      expect(await done).toMatchObject({ status: "completed" });
      expect(warnings).toEqual([]);
      await server.close();
      server = undefined;
    }
    expect(received).toEqual(["priority", "ultrafast", null]);
  } finally {
    await server?.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await snapshot.dispose();
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);
