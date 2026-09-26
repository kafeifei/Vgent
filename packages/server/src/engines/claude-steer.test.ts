import { experimental_createBridgeUserMessageSubmitter } from "@ai-sdk/harness/utils";
import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import { trackClaudeSteers } from "./claude-steer.js";

describe("Claude steer lifecycle", () => {
  it("keeps the user's id through the bridge and accepts a receipt separately from processing", async () => {
    const sent: Array<{ messageId: string; text: string }> = [];
    let respond!: (response: { messageId: string; accepted: boolean }) => void;
    let reconnect!: () => void;
    const submitter = experimental_createBridgeUserMessageSubmitter({
      send: message => { sent.push(message); },
      onResponse: callback => { respond = callback; return () => {}; },
      onReconnect: callback => { reconnect = callback; return () => {}; },
    });
    const receipt = submitter.submit("补充当前任务", "user-steer-1");
    reconnect();
    expect(sent.map(message => message.messageId)).toEqual(["user-steer-1", "user-steer-1"]);
    respond({ messageId: "user-steer-1", accepted: true });
    await receipt;
    submitter.close();
  });

  it("only hides the pending action after started, not queued, and drains application before the next output", async () => {
    const states = ["queued", "started", "completed", "discarded"];
    const applied: string[] = [];
    const input: TextStreamPart<ToolSet>[] = [
      ...states.map(state => ({ type: "raw" as const, rawValue: { type: "vgent-steer-lifecycle", messageId: state, state } })),
      { type: "text-start", id: "answer" },
    ];
    const output = await Array.fromAsync(trackClaudeSteers(ReadableStream.from(input), async id => { applied.push(id); }));
    expect(applied).toEqual(["started", "completed"]);
    expect(output).toEqual([{ type: "text-start", id: "answer" }]);
  });
});
