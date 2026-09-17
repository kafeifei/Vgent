import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessagePart, UIDataTypes, UITools } from "ai";
import { shouldSendAutomatically } from "./autoSend";

type Part = UIMessagePart<UIDataTypes, UITools>;

const stepStart: Part = { type: "step-start" };

/** A `dynamic-tool` part, the simplest tool part shape `isToolUIPart` accepts. */
const tool = (toolCallId: string, state: string, extra: Record<string, unknown> = {}): Part =>
  ({ type: "dynamic-tool", toolName: "x", toolCallId, state, ...extra }) as Part;

const assistant = (parts: Part[]): UIMessage => ({ id: "a1", role: "assistant", parts });

describe("shouldSendAutomatically", () => {
  it("sends when one tool is approval-responded and a parallel tool call is still input-streaming (the bug)", () => {
    const messages = [
      assistant([
        stepStart,
        tool("edit-1", "approval-responded", { input: {}, approval: { id: "ap1", approved: true } }),
        tool("write-1", "input-streaming"),
      ]),
    ];
    expect(shouldSendAutomatically({ messages })).toBe(true);
  });

  it("does not send while the approved tool is still awaiting a response", () => {
    const messages = [
      assistant([
        stepStart,
        tool("edit-1", "approval-requested", { input: {}, approval: { id: "ap1" } }),
        tool("write-1", "input-streaming"),
      ]),
    ];
    expect(shouldSendAutomatically({ messages })).toBe(false);
  });

  it("does not send when only input-streaming parts are present", () => {
    const messages = [assistant([stepStart, tool("write-1", "input-streaming")])];
    expect(shouldSendAutomatically({ messages })).toBe(false);
  });

  it("sends on a single completed tool call with no approvals (askUserQuestion-style)", () => {
    const messages = [assistant([stepStart, tool("ask-1", "output-available", { input: {}, output: {} })])];
    expect(shouldSendAutomatically({ messages })).toBe(true);
  });

  it("does not send when the last message is from the user", () => {
    const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }];
    expect(shouldSendAutomatically({ messages })).toBe(false);
  });

  it("ignores an earlier step's unfinished part once a step-start resets the window", () => {
    const messages = [
      assistant([
        stepStart,
        tool("edit-1", "input-streaming"),
        stepStart,
        tool("write-1", "output-available", { input: {}, output: {} }),
      ]),
    ];
    expect(shouldSendAutomatically({ messages })).toBe(true);
  });
});
