import { afterEach, describe, expect, it, vi } from "vitest";
import { isToolUIPart, validateUIMessages } from "ai";
import { SCENARIOS } from "./fixtures";
import { localClient, StyleSession } from "./runtime";
import { buildTurns } from "@/features/worklog/turns";

const sessions: StyleSession[] = [];
const session = (id: string, delay = 0) => { const value = new StyleSession(SCENARIOS.find((scene) => scene.id === id)!, () => {}, delay); sessions.push(value); return value; };
afterEach(() => { for (const value of sessions.splice(0)) value.dispose(); vi.restoreAllMocks(); });

describe("chat style fixtures", () => {
  it("uses valid SDK message schemas across every scenario", async () => {
    expect(new Set(SCENARIOS.map((scene) => scene.id)).size).toBe(SCENARIOS.length);
    for (const scene of SCENARIOS) {
      if (scene.messages.length > 0) await expect(validateUIMessages({ messages: scene.messages })).resolves.toHaveLength(scene.messages.length);
      expect(() => buildTurns(scene.messages)).not.toThrow();
    }
  });
  it("fails closed on an unimplemented API method", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    await expect(localClient({}).deleteThread("real-thread")).rejects.toThrow("样例暂未提供");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("edits files, plans and drafts only inside one session", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
    const a = session("overview"); const b = session("overview");
    await a.client.revertFile(a.chat.id, "src/chat.ts");
    expect((await a.client.listChanges(a.chat.id)).files).toHaveLength(1);
    expect((await b.client.listChanges(b.chat.id)).files).toHaveLength(2);
    await a.client.putPlan(a.chat.id, "updated");
    expect((await b.client.getPlan(b.chat.id)).content).not.toBe("updated");
    await a.client.putDraft(a.chat.id, { text: "draft", attachments: [] });
    expect((await a.client.getDraft(a.chat.id)).text).toBe("draft");
    expect((await b.client.getDraft(b.chat.id)).text).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("streams through the actual Chat and can send a second turn", async () => {
    const value = session("empty");
    expect(await value.send("first")).toBe(true);
    expect(value.snapshot().status).toBe("idle");
    expect(value.chat.messages).toHaveLength(2);
    expect(value.chat.messages.at(-1)?.parts.some((part) => part.type === "text" && part.text.includes("真实聊天组件"))).toBe(true);
    await value.send("second");
    expect(value.chat.messages).toHaveLength(4);
  });
  it.each([true, false])("continues after approval %s without looping", async (approved) => {
    const value = session("approval");
    await value.chat.addToolApprovalResponse({ id: "approval-1", approved });
    await vi.waitFor(() => expect(value.snapshot().status).toBe("idle"));
    const part = value.chat.messages.at(-1)?.parts.find((part) => isToolUIPart(part) && part.toolCallId === "approval");
    expect(part && isToolUIPart(part) && part.state).toBe(approved ? "output-available" : "output-denied");
    expect(value.snapshot().pendingApprovals).toBe(0);
    expect(value.chat.messages).toHaveLength(2);
  });
  it("continues after a question answer", async () => {
    const value = session("question");
    await value.chat.addToolOutput({ tool: "askUserQuestions", toolCallId: "question", output: { action: "declined" } });
    await vi.waitFor(() => expect(value.snapshot().status).toBe("idle"));
    expect(value.chat.messages.at(-1)?.parts.some((part) => part.type === "text")).toBe(true);
  });
  it("stops and disposes a stream without leaving a live session", async () => {
    const value = session("empty", 20);
    const sending = value.send("stop");
    await vi.waitFor(() => expect(value.chat.status).toBe("streaming"));
    await value.stop(); await sending;
    expect(value.snapshot().status).toBe("interrupted");
    value.dispose();
    expect(await value.send("closed")).toBe(false);
  });
  it("can replay an empty conversation", async () => {
    const value = session("empty");
    await value.replay();
    expect(value.snapshot().status).toBe("idle");
    expect(value.chat.messages).toHaveLength(2);
  });
  it("reset restores the original fixture after local mutations", async () => {
    const original = JSON.stringify(SCENARIOS);
    const value = session("queue");
    await value.queue("new");
    value.patch({ title: "changed" });
    const reset = session("queue");
    expect(reset.snapshot().queue).toHaveLength(2);
    expect(reset.snapshot().title).toBe("排队与插话");
    expect(JSON.stringify(SCENARIOS)).toBe(original);
  });
});
