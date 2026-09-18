import { describe, expect, it } from "vitest";
import { EMPTY_MCP_FORM, fromForm, toForm, type McpForm } from "./mcpForm";

describe("toForm", () => {
  it("expands a stdio config, joining args and env onto their own lines", () => {
    expect(
      toForm({ name: "fs", command: "npx", args: ["-y", "server-fs"], env: { TOKEN: "abc", DEBUG: "1" } }),
    ).toEqual({
      name: "fs",
      kind: "stdio",
      command: "npx",
      argsText: "-y\nserver-fs",
      envText: "TOKEN=abc\nDEBUG=1",
      url: "",
    });
  });

  it("defaults a bare stdio config's args/env to empty text", () => {
    expect(toForm({ name: "fs", command: "npx" })).toEqual({
      name: "fs",
      kind: "stdio",
      command: "npx",
      argsText: "",
      envText: "",
      url: "",
    });
  });

  it("expands an http config, defaulting the transport", () => {
    expect(toForm({ name: "remote", url: "https://example.com/mcp" })).toEqual({
      ...EMPTY_MCP_FORM,
      name: "remote",
      kind: "http",
      url: "https://example.com/mcp",
    });
  });

  it("expands an sse config", () => {
    expect(toForm({ name: "remote", url: "https://example.com/sse", transport: "sse" })).toEqual({
      ...EMPTY_MCP_FORM,
      name: "remote",
      kind: "sse",
      url: "https://example.com/sse",
    });
  });
});

describe("fromForm", () => {
  const stdioForm = (patch: Partial<McpForm> = {}): McpForm => ({
    ...EMPTY_MCP_FORM,
    name: "fs",
    kind: "stdio",
    command: "npx",
    ...patch,
  });

  it("packs a stdio form, dropping empty args/env lines", () => {
    expect(fromForm(stdioForm({ argsText: "-y\n\nserver-fs\n", envText: "\nTOKEN=abc\n" }))).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "server-fs"],
      env: { TOKEN: "abc" },
    });
  });

  it("omits args/env entirely when there are none", () => {
    expect(fromForm(stdioForm())).toEqual({ name: "fs", command: "npx" });
  });

  it("rejects a stdio form with no command", () => {
    expect(fromForm(stdioForm({ command: "  " }))).toEqual({ error: "可执行文件不能为空" });
  });

  it("rejects a malformed env line", () => {
    expect(fromForm(stdioForm({ envText: "NOT_A_PAIR" }))).toEqual({
      error: '环境变量格式错误："NOT_A_PAIR"，应为 KEY=VALUE',
    });
  });

  it("packs an http form, omitting the default transport", () => {
    expect(fromForm({ ...EMPTY_MCP_FORM, name: "remote", kind: "http", url: "https://example.com/mcp" })).toEqual({
      name: "remote",
      url: "https://example.com/mcp",
    });
  });

  it("packs an sse form with its transport", () => {
    expect(fromForm({ ...EMPTY_MCP_FORM, name: "remote", kind: "sse", url: "https://example.com/sse" })).toEqual({
      name: "remote",
      url: "https://example.com/sse",
      transport: "sse",
    });
  });

  it("rejects an http/sse form with no url", () => {
    expect(fromForm({ ...EMPTY_MCP_FORM, name: "remote", kind: "http", url: "  " })).toEqual({ error: "URL 不能为空" });
  });

  it("rejects a form with no name", () => {
    expect(fromForm(stdioForm({ name: " " }))).toEqual({ error: "名称不能为空" });
  });
});
