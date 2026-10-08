import { afterEach, describe, expect, it } from "vitest";
import { createCopilotRelay, steadyItemIds } from "./copilot-relay.js";

const relays: Array<ReturnType<typeof createCopilotRelay>> = [];
afterEach(async () => { await Promise.all(relays.splice(0).map((relay) => relay.close())); });

/** A relay whose accounts answer with `reply`, recording what reached them. */
function relayFixture(reply: (url: string, init: RequestInit) => Response = () => Response.json({ ok: true })) {
  const calls: Array<{ account: string; url: string; init: RequestInit }> = [];
  const relay = createCopilotRelay((account) => ({ fetch: (async (url: string, init: RequestInit) => { calls.push({ account, url, init }); return reply(url, init); }) as typeof fetch }));
  relays.push(relay);
  return { relay, calls };
}

describe("Copilot relay", () => {
  it("passes an account's requests on to its Copilot, and only with its own key", async () => {
    const { relay, calls } = relayFixture();
    const { baseURL, apiKey } = await relay.endpoint("github-0a1b2c3d");
    expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/github-0a1b2c3d$/);
    const post = (headers: Record<string, string>, url = `${baseURL}/v1/messages?beta=true`) =>
      fetch(url, { method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "a,b", "x-other": "dropped", ...headers }, body: '{"model":"m"}' });

    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    expect(await (await post({ authorization: `Bearer ${apiKey}` })).json()).toEqual({ ok: true });
    expect((await post({ "x-api-key": apiKey })).status).toBe(200);
    expect((await post({ "x-api-key": apiKey }, baseURL.replace("github-0a1b2c3d", "codex"))).status).toBe(404);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ account: "github-0a1b2c3d", url: "https://api.githubcopilot.com/v1/messages", init: { method: "POST", body: '{"model":"m"}' } });
    expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json", accept: "*/*", "anthropic-beta": "a,b" });
    // One relay, one key, whichever account.
    expect((await relay.endpoint("github")).apiKey).toBe(apiKey);
  });

  it("hands Copilot's status and body back, and says why when it cannot reach it", async () => {
    let fail = false;
    const { relay } = relayFixture(() => {
      if (fail) throw new Error("GitHub account changed");
      return new Response('{"error":"nope"}', { status: 429, headers: { "content-type": "application/json", "content-encoding": "gzip", "retry-after": "7" } });
    });
    const { baseURL, apiKey } = await relay.endpoint("github");
    const limited = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: "{}" });
    expect([limited.status, limited.headers.get("retry-after"), limited.headers.get("content-encoding"), await limited.text()]).toEqual([429, "7", null, '{"error":"nope"}']);
    fail = true;
    const broken = await fetch(`${baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: "{}" });
    expect([broken.status, ((await broken.json()) as { error: { message: string } }).error.message]).toEqual([502, "GitHub account changed"]);
  });

  it("stops listening when closed, and starts again when asked", async () => {
    const { relay } = relayFixture();
    const first = await relay.endpoint("github");
    await relay.close();
    await expect(fetch(`${first.baseURL}/models`, { headers: { authorization: `Bearer ${first.apiKey}` } })).rejects.toThrow();
    const again = await relay.endpoint("github");
    expect((await fetch(`${again.baseURL}/models`, { headers: { authorization: `Bearer ${again.apiKey}` } })).status).toBe(200);
  });

  it("keeps each streamed Responses item on the id it was announced with", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { id: "A1", type: "reasoning" } },
      { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "A2", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "A3", delta: "thinking" },
      { type: "response.output_item.added", output_index: 1, item: { id: "B1", type: "function_call" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: "B2", delta: "{}" },
      { type: "response.output_item.done", output_index: 0, item: { id: "A4", type: "reasoning", encrypted_content: "e" } },
      { type: "response.completed", response: { output: [{ id: "A5" }, { id: "B3" }] } },
    ];
    const sse = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    // Split mid-line, the way a network hands it over.
    const bytes = new TextEncoder().encode(sse);
    const source = new ReadableStream<Uint8Array>({ start(controller) { for (let at = 0; at < bytes.length; at += 37) controller.enqueue(bytes.slice(at, at + 37)); controller.close(); } });
    const out = await new Response(source.pipeThrough(steadyItemIds())).text();
    const seen = out.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)) as Record<string, any>);
    expect(seen.map((event) => event.item_id ?? event.item?.id ?? event.response.output.map((item: { id: string }) => item.id).join())).toEqual(["A1", "A1", "A1", "B1", "B1", "A1", "A1,B1"]);
    expect(seen[5]?.item.encrypted_content).toBe("e");
    expect(out.split("\n").filter((line) => line.startsWith("event:"))).toHaveLength(events.length);
  });
});
