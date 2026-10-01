import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMCPClient } from "@ai-sdk/mcp";

vi.mock("@ai-sdk/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/mcp")>();
  return { ...actual, createMCPClient: vi.fn(actual.createMCPClient) };
});
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

describe("connectMcpServers: a server that answers nothing", () => {
  it("is given up on after the timeout, so the turn still starts, and the rest still connect", async () => {
    const warnings: string[] = [];
    const started = Date.now();
    // Reads its input and never says a word: an initialize request that gets no answer.
    const connection = await connectMcpServers(
      [{ name: "silent", command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"] }],
      { log: { warn: (message) => warnings.push(message) }, timeoutMs: 400 },
    );

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connection.tools).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("silent");
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


it("returns stable tool-name order across connection delays and enumeration order", async () => {
  const mock = vi.mocked(createMCPClient);
  try {
    for (const reverse of [false, true]) {
      const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
      for (const index of [0, 1]) {
        mock.mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, (reverse ? index === 0 : index === 1) ? 15 : 0));
          return {
            tools: async () => Object.fromEntries((reverse ? ["a", "z"] : ["z", "a"]).map((name) => [name, fakeServerTools().listIssues!])),
            close: closes[index],
          } as unknown as Awaited<ReturnType<typeof createMCPClient>>;
        });
      }
      const connection = await connectMcpServers([{ name: "z", url: "https://z.test" }, { name: "a", url: "https://a.test" }]);
      expect(Object.keys(connection.tools)).toEqual(["a__a", "a__z", "z__a", "z__z"]);
      expect(Object.values(connection.tools).every((tool) => tool.deferLoading === true)).toBe(true);
      await connection.close();
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    }
  } finally {
    mock.mockReset();
    mock.mockImplementation((await vi.importActual<typeof import("@ai-sdk/mcp")>("@ai-sdk/mcp")).createMCPClient);
  }
});
