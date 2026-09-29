import { streamText, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createCodexSubscriptionModel } from "./codex-model.js";

const ENCRYPTED = "gAAAAA-fake-encrypted-reasoning";
const REASONING_ITEM_ID = "rs_fake_item_id";

/**
 * A turn replayed from stored history: the assistant's reasoning comes back
 * with both the item id the endpoint assigned and the encrypted content the
 * `reasoning.encrypted_content` include returned.
 */
const REPLAYED_HISTORY: ModelMessage[] = [
  { role: "user", content: "写个文件" },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "",
        providerOptions: { openai: { itemId: REASONING_ITEM_ID, reasoningEncryptedContent: ENCRYPTED } },
      },
      { type: "text", text: "好的" },
    ],
  },
  { role: "user", content: "继续" },
];

/** Runs one turn against a capturing fetch and returns the body that went out. */
async function captureRequest(messages: ModelMessage[], serviceTier?: string): Promise<Record<string, unknown>> {
  return (await captureWireRequest(messages, serviceTier == null ? {} : { providerOptions: { openai: { serviceTier } } })).body;
}

async function captureWireRequest(
  messages: ModelMessage[],
  options: Pick<Parameters<typeof streamText>[0], "instructions" | "providerOptions" | "headers" | "allowSystemInMessages"> = {},
): Promise<{ body: Record<string, unknown>; sessionId: string | null }> {
  let body: string | undefined;
  let sessionId: string | null = null;
  const model = createCodexSubscriptionModel("gpt-5.5", {
    accessToken: "fake-token",
    fetch: async (_url, init) => {
      body = String(init?.body);
      sessionId = new Headers(init?.headers).get("session-id");
      throw new Error("captured");
    },
  });
  try {
    const result = streamText({ model, messages, ...options, maxRetries: 0 });
    for await (const _part of result.stream) {
      // drained only so the call is actually issued
    }
  } catch {
    // the capturing fetch always throws
  }
  if (body == null) throw new Error("请求没有发出");
  return { body: JSON.parse(body) as Record<string, unknown>, sessionId };
}

describe("createCodexSubscriptionModel", () => {
  it.each(["priority", "ultrafast"])("preserves %s through AI SDK validation and the subscription body rewrite", async (tier) => {
    const request = await captureRequest([{ role: "user", content: "OK" }], tier);
    expect(request.service_tier).toBe(tier);
  });

  it("passes task cache identity and reasoning settings through the SDK to the wire", async () => {
    const taskId = "test-task-cache-session";
    const { body, sessionId } = await captureWireRequest([{ role: "user", content: "继续" }], {
      headers: { "session-id": taskId },
      providerOptions: {
        openai: {
          promptCacheKey: taskId,
          reasoningSummary: "auto",
          reasoningEffort: "high",
          serviceTier: "priority",
        },
      },
    });

    expect(sessionId).toBe(taskId);
    expect(body).toMatchObject({
      prompt_cache_key: taskId,
      store: false,
      reasoning: { summary: "auto", effort: "high" },
      service_tier: "priority",
    });
  });

  it("keeps a runtime snapshot in input with instruction authority instead of changing the prefix", async () => {
    const instructions = "Stable coding instructions.";
    const snapshot = "Runtime snapshot: current task is running in plan mode.";
    const { body } = await captureWireRequest(
      [
        { role: "user", content: "开始" },
        { role: "system", content: snapshot },
        { role: "user", content: "继续" },
      ],
      { instructions, allowSystemInMessages: true },
    );

    expect(body.instructions).toBe(instructions);
    expect(body.instructions).not.toContain(snapshot);
    const input = body.input as Record<string, unknown>[];
    expect(input).toHaveLength(3);
    expect(input[0]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "开始" }] });
    expect(["system", "developer"]).toContain(input[1]?.role);
    expect(input[1]?.role).not.toBe("user");
    // The SDK may encode instruction content as a string or input_text parts.
    expect([snapshot, [{ type: "input_text", text: snapshot }]]).toContainEqual(input[1]?.content);
    expect(input[2]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "继续" }] });
  });

  it("replays reasoning inline instead of referencing a stored item", async () => {
    const request = await captureRequest(REPLAYED_HISTORY);
    const input = request.input as Record<string, unknown>[];

    // `store: false` is forced on the wire, so a reference to a server-side item
    // would come back as "Items are not persisted when `store` is set to false".
    expect(request.store).toBe(false);
    expect(input.some((item) => item.type === "item_reference")).toBe(false);

    const reasoning = input.find((item) => item.type === "reasoning");
    expect(reasoning).toMatchObject({ encrypted_content: ENCRYPTED });
    // The id travels nowhere: the encrypted content is the whole payload.
    expect(reasoning).not.toHaveProperty("id");
    expect(JSON.stringify(request)).not.toContain(REASONING_ITEM_ID);
  });
});
