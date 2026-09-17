import { describe, expect, it } from "vitest";
import { describeTool, diffStatOf, exitCodeOf, outputText, type ToolPart } from "./toolMeta";

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

  it("hands write/edit a file for the chip and falls back to the tool name", () => {
    expect(describeTool(part("tool-edit", { file_path: "a/b.ts" })).file).toBe("a/b.ts");
    expect(describeTool(part("tool-write", { file_path: "a/b.ts" })).kind).toBe("write");
    expect(describeTool(part("tool-TodoWrite", {})).verb).toBe("TodoWrite");
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
