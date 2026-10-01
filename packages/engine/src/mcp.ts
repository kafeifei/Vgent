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

/**
 * A server that says nothing must not hold the turn: connecting to it and
 * listing its tools get this long, and then the turn goes on without it.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Starts one server. `abandon` is what to do with a server that never answered:
 * for a local process it kills the child, which is otherwise left running on
 * every turn for as long as the entry stays in the settings.
 */
function startOne(config: McpServerConfig): { client: Promise<MCPClient>; abandon: () => Promise<void> } {
  if (isStdio(config)) {
    const transport = new Experimental_StdioMCPTransport({
      command: config.command,
      ...(config.args == null ? {} : { args: config.args }),
      ...(config.env == null ? {} : { env: config.env }),
    });
    return { client: createMCPClient({ transport }), abandon: () => transport.close().catch(() => {}) };
  }
  return { client: createMCPClient({ transport: { type: config.transport ?? "http", url: config.url } }), abandon: async () => {} };
}

async function connectWithin(config: McpServerConfig, timeoutMs: number): Promise<{ client: MCPClient; tools: ToolSet }> {
  const started = startOne(config);
  const attempt = (async () => {
    const client = await started.client;
    try {
      return { client, tools: await client.tools() };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${timeoutMs / 1000} 秒内没有响应`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    // Whatever the attempt turns into after this is nobody's: stop the process,
    // and close the client should it still arrive.
    await started.abandon();
    void attempt.then(({ client }) => client.close().catch(() => {}), () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connects every configured server and returns their tools as one set. Servers
 * are connected in parallel; each failure is logged and skipped.
 */
export async function connectMcpServers(
  configs: readonly McpServerConfig[],
  options: { log?: McpLogger; /** Per server; defaults to 30 s. */ timeoutMs?: number } = {},
): Promise<McpConnection> {
  const { log } = options;
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};

  await Promise.all(
    configs.map(async (config) => {
      try {
        const { client, tools: found } = await connectWithin(config, options.timeoutMs ?? CONNECT_TIMEOUT_MS);
        clients.push(client);
        Object.assign(tools, prepareMcpTools(config.name, found));
      } catch (error) {
        log?.warn(`MCP 服务 ${config.name} 连接失败，已跳过`, error);
      }
    }),
  );

  return {
    tools: Object.fromEntries(Object.keys(tools).sort().map((name) => [name, tools[name]!])),
    close: async () => {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
