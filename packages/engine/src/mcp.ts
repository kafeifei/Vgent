/**
 * MCP servers as extra engine tools.
 *
 * Every MCP tool is registered with `deferLoading: true`, so a server with
 * forty tools costs the model nothing until it searches for one with
 * `toolSearch`. A server that fails to connect is a warning, never an
 * exception: one broken entry in the user's settings must not kill the turn.
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";

/** A local server Vgent spawns itself. */
export interface McpStdioServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A server that is already running somewhere and speaks HTTP or SSE. */
export interface McpHttpServerConfig {
  name: string;
  url: string;
  /** Defaults to `http`. */
  transport?: "http" | "sse";
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConnection {
  /** Every connected server's tools, prefixed and deferred. Empty when nothing connected. */
  tools: ToolSet;
  /** Closes every client. Never throws. */
  close(): Promise<void>;
}

/** The minimum of `Logger` this module needs, so it does not depend on the server's. */
export interface McpLogger {
  warn(message: string, ...rest: unknown[]): void;
}

const isStdio = (config: McpServerConfig): config is McpStdioServerConfig => "command" in config;

/** Tool names travel to the model, which only accepts this alphabet. */
const sanitizeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Namespaces a server's tools and defers them all. Split out from
 * `connectMcpServers` so the naming rule can be tested without a live server.
 */
export function prepareMcpTools(serverName: string, tools: ToolSet): ToolSet {
  const prefix = sanitizeName(serverName);
  const prepared: ToolSet = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    prepared[`${prefix}__${sanitizeName(toolName)}`] = { ...definition, deferLoading: true };
  }
  return prepared;
}

/** Whether any tool in the set is hidden until `toolSearch` finds it. */
export const hasDeferredTools = (tools: ToolSet): boolean =>
  Object.values(tools).some((definition) => definition.deferLoading === true);

/**
 * Reads a user-supplied value (settings file, `--mcp` JSON) as a server list.
 * Throws on anything that is not the documented shape — a silently dropped
 * server would look exactly like a server whose tools the model never found.
 */
export function parseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) throw new Error("mcpServers 必须是数组");
  return value.map((entry, index) => {
    const where = `mcpServers[${index}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} 必须是对象`);
    const record = entry as Record<string, unknown>;
    const { name } = record;
    if (typeof name !== "string" || name.trim() === "") throw new Error(`${where}.name 必须是非空字符串`);

    if (typeof record.command === "string" && record.command !== "") {
      const { args, env } = record;
      if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) {
        throw new Error(`${where}.args 必须是字符串数组`);
      }
      if (env !== undefined && !(typeof env === "object" && env !== null && Object.values(env).every((v) => typeof v === "string"))) {
        throw new Error(`${where}.env 必须是字符串字典`);
      }
      return {
        name,
        command: record.command,
        ...(args === undefined ? {} : { args: args as string[] }),
        ...(env === undefined ? {} : { env: env as Record<string, string> }),
      };
    }

    if (typeof record.url === "string" && record.url !== "") {
      const { transport } = record;
      if (transport !== undefined && transport !== "http" && transport !== "sse") {
        throw new Error(`${where}.transport 只能是 "http" 或 "sse"`);
      }
      return { name, url: record.url, ...(transport === undefined ? {} : { transport }) };
    }

    throw new Error(`${where} 需要 command（本地进程）或 url（远程服务）`);
  });
}

async function connectOne(config: McpServerConfig): Promise<MCPClient> {
  if (isStdio(config)) {
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: config.command,
        ...(config.args == null ? {} : { args: config.args }),
        ...(config.env == null ? {} : { env: config.env }),
      }),
    });
  }
  return createMCPClient({ transport: { type: config.transport ?? "http", url: config.url } });
}

/**
 * Connects every configured server and returns their tools as one set. Servers
 * are connected in parallel; each failure is logged and skipped.
 */
export async function connectMcpServers(
  configs: readonly McpServerConfig[],
  options: { log?: McpLogger } = {},
): Promise<McpConnection> {
  const { log } = options;
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};

  await Promise.all(
    configs.map(async (config) => {
      try {
        const client = await connectOne(config);
        clients.push(client);
        Object.assign(tools, prepareMcpTools(config.name, await client.tools()));
      } catch (error) {
        log?.warn(`MCP 服务 ${config.name} 连接失败，已跳过`, error);
      }
    }),
  );

  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
