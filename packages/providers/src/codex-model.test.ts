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
async function captureRequest(messages: ModelMessage[]): Promise<Record<string, unknown>> {
  let body: string | undefined;
  const model = createCodexSubscriptionModel("gpt-5.5", {
    accessToken: "fake-token",
    fetch: async (_url, init) => {
      body = String(init?.body);
      throw new Error("captured");
    },
  });
  try {
    const result = streamText({ model, messages });
    for await (const _part of result.stream) {
      // drained only so the call is actually issued
    }
  } catch {
    // the capturing fetch always throws
  }
  if (body == null) throw new Error("请求没有发出");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("createCodexSubscriptionModel", () => {
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
