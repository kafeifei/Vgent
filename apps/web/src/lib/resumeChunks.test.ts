import { describe, expect, it } from "vitest";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { withResumePrelude } from "./resumeChunks";

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/** A chat whose reconnect replays `chunks`, repaired against its own history. */
function resumable(chunks: UIMessageChunk[], hydrated: UIMessage[]) {
  const errors: Error[] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async () => streamOf([]),
    reconnectToStream: async () => {
      const last = chat.messages.at(-1);
      return withResumePrelude(streamOf(chunks), last?.role === "assistant" ? last : undefined);
    },
  };
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id: "t",
    messages: [],
    transport,
    onError: (error) => errors.push(error),
  });
  chat.messages = hydrated;
  return { chat, errors };
}

/** What the server replays for a turn that continues the previous message. */
const continuation: UIMessageChunk[] = [
  { type: "start", messageId: "m1" },
  { type: "tool-approval-response", approvalId: "ap1", approved: true },
  { type: "tool-output-available", toolCallId: "tc1", output: { stdout: "web-check" } },
  { type: "start-step" },
  { type: "text-start", id: "t9" },
  { type: "text-delta", id: "t9", delta: "web-check" },
  { type: "text-end", id: "t9" },
  { type: "finish" },
];

const awaitingApproval: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "跑一下" }] },
  {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "这就跑。", state: "done" },
      {
        type: "tool-bash",
        toolCallId: "tc1",
        state: "approval-responded",
        input: { command: "sleep 8 && echo web-check" },
        approval: { id: "ap1", approved: true },
      },
    ] as UIMessage["parts"],
  },
];

describe("withResumePrelude", () => {
  it("rebuilds the message a continuation stream addresses", async () => {
    const { chat, errors } = resumable(continuation, awaitingApproval);

    await chat.resumeStream();

    expect(errors).toEqual([]);
    const parts = chat.messages.at(-1)?.parts ?? [];
    expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["这就跑。", "web-check"]);
    const tool = parts.find((part) => part.type === "tool-bash");
    expect(tool).toMatchObject({ state: "output-available", output: { stdout: "web-check" } });
  });

  it("is what stands between the replay and the crash", async () => {
    // Unrepaired, and with the history already loaded: the SDK still builds the
    // resume state from a blank message, so the first chunk finds nothing.
    const errors: Error[] = [];
    const bare = new Chat<UIMessage>({
      id: "t",
      messages: awaitingApproval,
      transport: { sendMessages: async () => streamOf([]), reconnectToStream: async () => streamOf(continuation) },
      onError: (error) => errors.push(error),
    });

    await bare.resumeStream();

    expect(errors.map((error) => error.message)).toEqual(['No tool invocation found for approval ID "ap1".']);
  });

  it("leaves a replay that builds its own message alone", async () => {
    const fresh: UIMessageChunk[] = [
      { type: "start", messageId: "m2" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "hello" },
      { type: "text-end", id: "t1" },
      { type: "finish" },
    ];
    const partial: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "m2",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "text", text: "hel", state: "streaming" }],
      },
    ];
    const { chat, errors } = resumable(fresh, partial);

    await chat.resumeStream();

    expect(errors).toEqual([]);
    // No doubled text: the replay already carried every chunk of that message.
    expect(chat.messages.at(-1)?.parts).toEqual([{ type: "step-start" }, { type: "text", text: "hello", state: "done" }]);
  });
});
