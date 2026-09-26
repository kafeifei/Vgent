import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StructuredData, ToolResult, readableValue, recordColumns } from "./StructuredData";
import { ToolDetail } from "./ToolDetail";
const noop = () => {};
const render = (value: unknown) => renderToStaticMarkup(<StructuredData value={value} onOpenFile={noop} />);

describe("tool result presentation", () => {
  it("reads structured JSON strings and preserves ordinary or incomplete text", () => {
    expect(readableValue('{"ok":true}')).toEqual({ ok: true });
    expect(readableValue("[1,2]")).toEqual([1, 2]);
    expect(readableValue('{"unfinished":')).toBe('{"unfinished":');
    expect(readableValue("plain text")).toBe("plain text");
  });
  it("shows fields, short lists and empty values without a JSON block", () => {
    const html = render({ node: "chat/composer", spacing: 16, tokens: ["bg", "fg-muted"], warnings: [], missing: null });
    expect(html).toContain("节点"); expect(html).toContain("chat/composer");
    expect(html).toContain("fg-muted"); expect(html).toContain("未提供");
    expect(html).not.toContain("<pre"); expect(html).not.toContain("&quot;node&quot;");
  });
  it("uses a table only for flat records with a manageable number of columns", () => {
    expect(recordColumns([{ path: "a", line: 1 }, { path: "b", line: 2 }])).toEqual(["path", "line"]);
    expect(recordColumns([{ nested: { value: 1 } }])).toBeUndefined();
    expect(recordColumns(Array.from({ length: 7 }, (_, i) => ({ [`field-${i}`]: i })))).toBeUndefined();
    expect(render([{ path: "src/a.ts", line: 1 }])).toContain("<table");
  });
  it("renders path actions while escaping untrusted markup", () => {
    const html = render({ path: "src/chat.ts", name: '<img src=x onerror="alert(1)">' });
    expect(html).toContain("<button"); expect(html).toContain("&lt;img"); expect(html).not.toContain("<img");
  });
  it("keeps nested objects folded and large collections paginated", () => {
    expect(render({ nested: { secretLeaf: "leaf" } })).not.toContain("secretLeaf");
    const html = render(Array.from({ length: 50 }, (_, i) => `row-${i}`));
    expect(html).toContain("row-19"); expect(html).not.toContain("row-20"); expect(html).toContain("剩余 30 项");
  });
  it("bounds long strings, including raw multiline output", () => {
    const html = render({ stdout: "a".repeat(4000) + "TAIL" });
    expect(html).toContain("<pre"); expect(html).not.toContain("TAIL"); expect(html).toContain("展开更多");
  });
  it("renders MCP structured text while preserving envelope metadata", () => {
    const html = renderToStaticMarkup(<ToolResult value={{ content: [{ type: "text", text: '{"count":3}' }], isError: false, trace: "kept" }} onOpenFile={noop} />);
    expect(html).toContain("数量"); expect(html).toContain("kept"); expect(html).toContain("错误标记");
  });
  it("keeps unknown MCP content types inspectable", () => {
    const html = renderToStaticMarkup(<ToolResult value={{ content: [{ type: "future-format", uri: "sample://result" }] }} onOpenFile={noop} />);
    expect(html).toContain("future-format"); expect(html).toContain("sample://result");
  });
  it("previews supported MCP images instead of their base64 payload", () => {
    const html = renderToStaticMarkup(<ToolResult value={{ content: [{ type: "image", mimeType: "image/png", data: "sample-base64" }] }} onOpenFile={noop} />);
    expect(html).toContain('<img src="data:image/png;base64,sample-base64"');
    expect(html).toContain("查看工具返回的图片 1");
    expect(html).not.toContain("<pre");
  });
  it("does not report an MCP error result as completed", () => {
    const html = renderToStaticMarkup(<ToolDetail part={{ type: "dynamic-tool", toolName: "mcp__design__inspect", toolCallId: "mcp-error", state: "output-available", input: {}, output: { isError: true, content: [{ type: "text", text: "检查失败" }] } }} onOpenFile={noop} />);
    expect(html).toContain("失败"); expect(html).not.toContain("已完成");
    expect(html).toContain("检查失败"); expect(html).toContain("输出原始数据");
  });
  it("shows plan steps and preserves extra input fields", () => {
    const html = renderToStaticMarkup(<ToolDetail part={{ type: "dynamic-tool", toolName: "update_plan", toolCallId: "plan", state: "output-available", input: { explanation: "补充检查", plan: [{ step: "运行测试", status: "completed" }] }, output: { ok: true } }} onOpenFile={noop} />);
    expect(html).toContain("运行测试"); expect(html).toContain("补充检查");
    expect(html).not.toContain("<pre"); expect(html).toContain("输入原始数据");
  });
});
