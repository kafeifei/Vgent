import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createVgentEngine } from "./engine.js";
import { connectMcpServers, hasDeferredTools, parseMcpServers, prepareMcpTools } from "./mcp.js";

let repoPath: string;

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), "vgent-mcp-"));
});

const fakeServerTools = (): ToolSet => ({
  "get weather": tool({
    description: "Weather for a city.",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, forecast: "rain" }),
  }),
  listIssues: tool({
    description: "List issues.",
    inputSchema: z.object({}),
    execute: async () => [],
  }),
});

describe("prepareMcpTools", () => {
  it("namespaces every tool and defers all of them", () => {
    const prepared = prepareMcpTools("my server!", fakeServerTools());

    expect(Object.keys(prepared).sort()).toEqual(["my_server___get_weather", "my_server___listIssues"]);
    expect(Object.values(prepared).every((definition) => definition.deferLoading === true)).toBe(true);
    // Everything else survives the rewrite: description and executable body.
    expect(prepared.my_server___listIssues?.description).toBe("List issues.");
    expect(hasDeferredTools(prepared)).toBe(true);
    expect(hasDeferredTools(fakeServerTools())).toBe(false);
  });
});

describe("parseMcpServers", () => {
  it("accepts both transports and keeps only the documented fields", () => {
    const configs = parseMcpServers([
      { name: "local", command: "node", args: ["server.js"], env: { TOKEN: "x" } },
      { name: "remote", url: "https://example.test/mcp", transport: "sse" },
      { name: "plain", url: "https://example.test/mcp" },
    ]);

    expect(configs).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: { TOKEN: "x" } },
      { name: "remote", url: "https://example.test/mcp", transport: "sse" },
      { name: "plain", url: "https://example.test/mcp" },
    ]);
  });

  it("rejects anything that is not a server list", () => {
    expect(() => parseMcpServers({})).toThrow(/数组/);
    expect(() => parseMcpServers([{ command: "node" }])).toThrow(/name/);
    expect(() => parseMcpServers([{ name: "x" }])).toThrow(/command.*url/s);
    expect(() => parseMcpServers([{ name: "x", command: "node", args: "server.js" }])).toThrow(/args/);
    expect(() => parseMcpServers([{ name: "x", url: "https://a.test", transport: "ws" }])).toThrow(/transport/);
  });
});

describe("connectMcpServers", () => {
  it("skips a server it cannot reach instead of failing the turn", async () => {
    const warnings: string[] = [];
    const connection = await connectMcpServers([{ name: "broken", command: "vgent-no-such-command-ever" }], {
      log: { warn: (message) => warnings.push(message) },
    });

    expect(connection.tools).toEqual({});
    expect(warnings[0]).toContain("broken");
    await expect(connection.close()).resolves.toBeUndefined();
  });
});

describe("createVgentEngine with extra tools", () => {
  const model = new MockLanguageModelV3({});

  it("adds toolSearch only when some tool is deferred", () => {
    const deferred = createVgentEngine({ model, repoPath, extraTools: prepareMcpTools("srv", fakeServerTools()) });
    expect(Object.keys(deferred.tools)).toContain("toolSearch");
    expect(Object.keys(deferred.tools)).toContain("srv__listIssues");
    expect(deferred.tools.toolSearch?.deferLoading).toBeUndefined();

    const eager = createVgentEngine({ model, repoPath, extraTools: fakeServerTools() });
    expect(Object.keys(eager.tools)).not.toContain("toolSearch");
  });

  it("offers the subagent tools by default and drops them on request", () => {
    expect(Object.keys(createVgentEngine({ model, repoPath }).tools)).toEqual(
      expect.arrayContaining(["explore", "coder"]),
    );
    const bare = createVgentEngine({ model, repoPath, subagents: false });
    expect(Object.keys(bare.tools)).not.toContain("explore");
    expect(Object.keys(bare.tools)).not.toContain("coder");
  });
});
