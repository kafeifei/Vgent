import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";
import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { stripDeniedApprovalResults } from "./harness-messages.js";

/** What the client posts back after 「允许」/「拒绝」 on a gated bash call. */
const answered = (approved: boolean): UIMessage[] =>
  [
    { id: "u1", role: "user", parts: [{ type: "text", text: "用 bash 执行 echo deny-test" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          toolCallId: "call-1",
          state: "approval-responded",
          input: { command: "echo deny-test" },
          providerExecuted: true,
          approval: { id: "ap-1", approved },
        },
      ],
    },
  ] as unknown as UIMessage[];

describe("stripDeniedApprovalResults", () => {
  /**
   * The bug this exists for: `convertToModelMessages` pairs a denied approval
   * with a synthetic `execution-denied` result, and the harness then reads that
   * result as "already settled" and drops the approval response — so nothing
   * ever answers the runtime's pending `canUseTool`, and the turn hangs.
   */
  it("makes a denied approval reach the harness as a continuation", async () => {
    const messages = await convertToModelMessages(answered(false));

    // Untouched, the harness sees no continuation at all.
    expect(collectHarnessAgentToolApprovalContinuations({ messages })).toEqual([]);

    const stripped = stripDeniedApprovalResults(messages);
    expect(collectHarnessAgentToolApprovalContinuations({ messages: stripped })).toMatchObject([
      { type: "tool-approval-response", approvalId: "ap-1", approved: false },
    ]);
    // The history still ends in `role: 'tool'`, which is what both the run
    // manager and the harness read as "continue the open turn".
    expect(stripped.at(-1)?.role).toBe("tool");
    expect(stripped.at(-1)?.content).toMatchObject([{ type: "tool-approval-response", approvalId: "ap-1", approved: false }]);
  });

  it("leaves an approved answer exactly as it was", async () => {
    const messages = await convertToModelMessages(answered(true));
    expect(stripDeniedApprovalResults(messages)).toBe(messages);
    expect(collectHarnessAgentToolApprovalContinuations({ messages })).toMatchObject([{ approvalId: "ap-1", approved: true }]);
  });

  it("keeps a real tool result, and anything that is not an open turn", async () => {
    const executed = await convertToModelMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "读一下" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-read", toolCallId: "call-2", state: "output-available", input: { path: "a.txt" }, output: { text: "ok" } }],
      },
    ] as unknown as UIMessage[]);
    expect(stripDeniedApprovalResults(executed)).toBe(executed);

    const prompt = await convertToModelMessages([{ id: "u1", role: "user", parts: [{ type: "text", text: "你好" }] }] as UIMessage[]);
    expect(stripDeniedApprovalResults(prompt)).toBe(prompt);
  });
});
