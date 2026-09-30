import { describe, expect, it } from "vitest";
import { describeTool, diffStatOf, exitCodeOf, outputText, toolTitle, withoutCd, type ToolPart } from "./toolMeta";

const part = (type: string, input: unknown): ToolPart =>
  ({ type, toolCallId: "c1", state: "output-available", input, output: {} }) as unknown as ToolPart;

describe("describeTool", () => {
  it("maps both our tool names and the harness ones to the same verbs", () => {
    expect(describeTool(part("tool-read", { file_path: "src/x.ts" }))).toMatchObject({ verb: "读取", target: "src/x.ts" });
    expect(describeTool(part("tool-Read", { file_path: "src/x.ts" }))).toMatchObject({ verb: "读取" });
    expect(describeTool(part("tool-Bash", { command: "pnpm test" }))).toMatchObject({ verb: "$", target: "pnpm test" });
    expect(describeTool(part("tool-Grep", { pattern: "createApp" }))).toMatchObject({ verb: "搜索", target: "createApp" });
    expect(describeTool(part("tool-Task", { description: "查找续流实现" }))).toMatchObject({ verb: "子代理" });
  });

  it("reads OpenCode's `filePath` like the other engines' path fields", () => {
    expect(describeTool(part("tool-read", { filePath: "/repo/a.txt" }))).toMatchObject({ verb: "读取", target: "/repo/a.txt" });
    expect(describeTool(part("tool-edit", { filePath: "/repo/a.txt", oldString: "a", newString: "b" }))).toMatchObject({ verb: "编辑", file: "/repo/a.txt" });
    expect(describeTool(part("tool-webfetch", { url: "https://example.com" }))).toMatchObject({ target: "https://example.com" });
    expect(describeTool(part("tool-edit", { patchText: "*** Begin Patch\n*** Add File: b.txt\n+world\n*** End Patch" }))).toMatchObject({ verb: "编辑", file: "b.txt" });
  });

  it("drops the leading cd from a command's line and keeps the rest", () => {
    expect(withoutCd("cd /Users/me/Codes/Vgent; git status --short")).toBe("git status --short");
    expect(withoutCd("cd \"/tmp/a b\" && ls")).toBe("ls");
    expect(withoutCd("cd /tmp")).toBe("cd /tmp");
    expect(withoutCd("git log | cd x")).toBe("git log | cd x");
  });

  it("prefers an Engine title or description without changing the command or its terminal routing", () => {
    const command = "node -e 'console.log(1)'";
    const call = part("tool-bash", { command, description: "提取界面实现片段" });
    expect(describeTool(call)).toMatchObject({ kind: "bash", verb: "执行", target: "提取界面实现片段" });
    expect(describeTool({ ...call, title: "查看初始化实现" })).toMatchObject({ target: "查看初始化实现" });
    expect(describeTool({ ...call, title: "  " })).toMatchObject({ target: "提取界面实现片段" });
    expect(call.input).toEqual({ command, description: "提取界面实现片段" });
  });

  it("hands write/edit a file for the chip and falls back to the tool name", () => {
    expect(describeTool(part("tool-edit", { file_path: "a/b.ts" })).file).toBe("a/b.ts");
    expect(describeTool(part("tool-write", { file_path: "a/b.ts" })).kind).toBe("write");
  });

  it("reads TodoWrite/update_plan/updatePlan as a plan row with an item count", () => {
    expect(describeTool(part("tool-TodoWrite", { todos: [{ content: "a", status: "pending" }] }))).toMatchObject({
      kind: "plan",
      verb: "计划",
      target: "1 项",
    });
    expect(
      describeTool(part("tool-update_plan", { plan: [{ step: "a", status: "pending" }, { step: "b", status: "done" }] })),
    ).toMatchObject({ kind: "plan", verb: "计划", target: "2 项" });
    expect(describeTool(part("tool-updatePlan", { items: [] }))).toMatchObject({ kind: "plan", verb: "计划", target: "0 项" });
  });
});

describe("output readers", () => {
  it("reads an exit code only when the engine reports one", () => {
    expect(exitCodeOf({ exitCode: 0 })).toBe(0);
    expect(exitCodeOf({ exit_code: 2 })).toBe(2);
    expect(exitCodeOf({ stdout: "hi" })).toBeUndefined();
  });

  it("counts a unified diff without counting its headers", () => {
    expect(diffStatOf({ diff: "--- a\n+++ b\n+one\n+two\n-three\n" })).toEqual({ added: 2, removed: 1 });
    expect(diffStatOf({})).toBeUndefined();
  });

  it("prefers a verbatim text field over JSON", () => {
    expect(outputText({ stdout: "     137" })).toBe("     137");
    expect(outputText("plain")).toBe("plain");
    expect(outputText({ totalLines: 3 })).toBeUndefined();
  });
});

describe("toolTitle", () => {
  it("names the known tools in Chinese, whatever the engine's casing", () => {
    expect(toolTitle("bash")).toBe("命令");
    expect(toolTitle("Write")).toBe("写入");
    expect(toolTitle("MultiEdit")).toBe("编辑");
  });

  it("falls back to the raw name for anything else", () => {
    expect(toolTitle("TodoWrite")).toBe("TodoWrite");
    expect(toolTitle("mcp__docs__search")).toBe("mcp__docs__search");
  });
});
