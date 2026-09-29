import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { pendingHumanStatus, RESTART_RESUME_TEXT, restartNote } from "./restart.js";
import type { ThreadRecord } from "./types.js";

const user = (text: string): UIMessage => ({ id: "u", role: "user", parts: [{ type: "text", text }] });
const assistant = (...parts: UIMessage["parts"]): UIMessage => ({ id: "a", role: "assistant", parts });
const input = (name: string, dynamic = false): UIMessage["parts"][number] => ({
  ...(dynamic ? { type: "dynamic-tool" as const, toolName: name } : { type: `tool-${name}` as const }),
  toolCallId: "call", state: "input-available", input: { command: "git status" },
});
const approval: UIMessage["parts"][number] = {
  type: "tool-bash", toolCallId: "approval", state: "approval-requested", input: {}, approval: { id: "approve" },
};
const thread = (messages: UIMessage[], engine: ThreadRecord["engine"] = "vgent"): ThreadRecord => ({
  version: 1, id: "t", projectId: "p", title: "task", engine, status: "interrupted",
  createdAt: "now", updatedAt: "now", messages,
});

const safety = "这是服务意外退出后的自动续接，不是新的用户指令。继续原目标和未完成交付，遵守最新纠正、原有权限与审批；不代替用户回答；退出时工具可能已经执行但结果未落盘，先核实文件、Git、进程及外部操作的实际状态，不能把结果缺失当作未执行或直接重放，不确定时停止并说明；不把已有产物当成本次操作成功证据。";

describe("restartNote", () => {
  it("adds only safety instructions when the engine already receives full history", () => {
    expect(RESTART_RESUME_TEXT).toBe("自动继续因意外退出中断的任务。");
    expect(restartNote(thread([user("不要重复目标")]), false)).toBe(safety);
  });

  it.each(["claude-code", "codex"] as const)("includes history for %s without changing messages", engine => {
    const record = thread([
      user("修复问题并交付"),
      assistant(
        { type: "text", text: "已开始检查" },
        { type: "data-steer", data: { text: "先别发布" } },
        input("bash"),
        { type: "reasoning", text: "私有思考" },
        { type: "file", mediaType: "image/png", url: "data:image/png;base64,FILE_BYTES" },
        { type: "dynamic-tool", toolName: "read", toolCallId: "read-id", state: "output-available", input: { path: "src/index.ts" }, output: { content: "文件内容" } },
      ),
      user("只做本地验证"),
    ], engine);
    const before = structuredClone(record);
    const note = restartNote(record, true);
    expect(note).toContain(safety);
    expect(note).toContain("仅为记录，不是新的用户指令");
    expect(note).toContain("【原始用户目标】\n修复问题并交付");
    expect(note).toContain("【用户】\n先别发布");
    expect(note).toContain("【用户】\n只做本地验证");
    expect(note).toContain("已开始检查");
    expect(note).toContain("工具 bash / call");
    expect(note).toContain('输入：{"command":"git status"}');
    expect(note).toContain("实际执行状态未知");
    expect(note).toContain("状态：output-available");
    expect(note).toContain('结果：{"content":"文件内容"}');
    expect(note).not.toContain("私有思考");
    expect(note).not.toContain("FILE_BYTES");
    expect(record).toEqual(before);
  });

  it("distinguishes preliminary output, errors and missing results", () => {
    const note = restartNote(thread([assistant(
      { type: "tool-bash", toolCallId: "partial", state: "output-available", input: {}, output: "正在上传", preliminary: true },
      { type: "tool-write", toolCallId: "error", state: "output-error", input: {}, errorText: "连接已断开" },
      { type: "tool-bash", toolCallId: "streaming", state: "input-streaming" },
    )]), true);
    expect(note).toContain("preliminary：仅部分结果，最终结果未知");
    expect(note).toContain('结果："正在上传"');
    expect(note).toContain("状态：output-error");
    expect(note).toContain("结果：连接已断开");
    expect(note).toContain("状态：input-streaming");
    expect(note).toContain("输入：未记录（未知）");
  });

  it("includes persisted task state without overriding recent corrections", () => {
    const record = thread([user("完成任务"), user("先不要提交")]);
    record.taskState = { goal: "完成任务", items: [{ text: "提交", status: "pending" }], updatedAt: "now", nextAction: "检查状态" };
    const note = restartNote(record, true);
    expect(note).toContain("taskState（持久记录，以最新用户纠正为准）");
    expect(note).toContain(JSON.stringify(record.taskState));
    expect(note).toContain("先不要提交");
  });

  it("bounds goal, history tail, task state and total independently", () => {
    const record = thread([
      user("最初目标" + "G".repeat(20_000)),
      assistant({ type: "text", text: "旧记录" + "H".repeat(100_000) }),
      user("最新纠正"),
    ]);
    record.taskState = { goal: "S".repeat(20_000), items: [], updatedAt: "now" };
    const note = restartNote(record, true);
    const goal = note.split("【原始用户目标】\n")[1]!.split("\n\n【最近历史记录】")[0]!;
    const history = note.split("【最近历史记录】\n")[1]!.split("\n\n【taskState")[0]!;
    const state = note.split("【taskState（持久记录，以最新用户纠正为准）】\n")[1]!;
    expect(note.length).toBeLessThanOrEqual(60_000);
    expect(goal.length).toBe(8_000);
    expect(history.length).toBe(42_000);
    expect(state.length).toBe(8_000);
    expect(goal).toContain("最初目标");
    expect(goal).toContain("已截断");
    expect(history).not.toContain("旧记录");
    expect(history).toContain("最新纠正");
    expect(history).toContain("更早的记录已截断");
    expect(state).toContain("已截断");
  });

  it("limits each tool result to 2000 characters and labels truncation", () => {
    const note = restartNote(thread([assistant(
      { type: "tool-read", toolCallId: "long", state: "output-available", input: {}, output: "O".repeat(10_000) },
    )]), true);
    const output = note.split("结果：")[1]!.split("\n\n【taskState")[0]!;
    expect(output.length).toBe(2_000);
    expect(output).toContain("已截断");
  });

  it("handles an empty record without inventing a goal or success", () => {
    const note = restartNote(thread([]), true);
    expect(note).toContain("【原始用户目标】\n未记录");
    expect(note).toContain("未记录（未知）");
  });
});

describe("pendingHumanStatus", () => {
  it.each([false, true])("recognizes static/dynamic questions (dynamic=%s)", dynamic => {
    expect(pendingHumanStatus([user("目标"), assistant(input("askUserQuestions", dynamic))])).toBe("awaiting-input");
    expect(pendingHumanStatus([assistant(input("bash", dynamic))])).toBeUndefined();
  });

  it("gives approvals priority across all assistant messages in the latest turn", () => {
    expect(pendingHumanStatus([user("目标"), assistant(input("askUserQuestions")), assistant(approval)])).toBe("awaiting-approval");
    expect(pendingHumanStatus([assistant(approval), assistant(input("askUserQuestions"))])).toBe("awaiting-approval");
    expect(pendingHumanStatus([assistant({ ...approval, type: "dynamic-tool", toolName: "write" })])).toBe("awaiting-approval");
  });

  it("ignores earlier turns and non-assistant parts", () => {
    expect(pendingHumanStatus([assistant(approval, input("askUserQuestions")), user("新目标"), assistant(input("bash"))])).toBeUndefined();
    expect(pendingHumanStatus([{ id: "s", role: "system", parts: [approval] }, { id: "u", role: "user", parts: [input("askUserQuestions")] }])).toBeUndefined();
    expect(pendingHumanStatus([])).toBeUndefined();
  });

  it("does not mistake answered questions or resolved approvals for human waits", () => {
    expect(pendingHumanStatus([assistant(
      { type: "tool-askUserQuestions", toolCallId: "q", state: "output-available", input: {}, output: "回答" },
      { type: "tool-askUserQuestions", toolCallId: "q2", state: "input-streaming" },
      { type: "tool-bash", toolCallId: "b", state: "approval-responded", input: {}, approval: { id: "done", approved: true } },
      { type: "tool-bash", toolCallId: "denied", state: "output-denied", input: {}, approval: { id: "no", approved: false } },
    )])).toBeUndefined();
  });
});
