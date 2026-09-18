import type { McpServerConfig } from "@/lib/types";

export type McpFormKind = "stdio" | "http" | "sse";

/** Everything the inline add/edit form needs, as plain strings a `<textarea>` can hold. */
export interface McpForm {
  name: string;
  kind: McpFormKind;
  command: string;
  /** One argument per line. */
  argsText: string;
  /** One `KEY=VALUE` per line. */
  envText: string;
  url: string;
}

export const EMPTY_MCP_FORM: McpForm = { name: "", kind: "stdio", command: "", argsText: "", envText: "", url: "" };

/** A saved config, expanded into the form's editable fields. */
export function toForm(config: McpServerConfig): McpForm {
  if ("command" in config) {
    return {
      name: config.name,
      kind: "stdio",
      command: config.command,
      argsText: (config.args ?? []).join("\n"),
      envText: Object.entries(config.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
      url: "",
    };
  }
  return {
    name: config.name,
    kind: config.transport === "sse" ? "sse" : "http",
    command: "",
    argsText: "",
    envText: "",
    url: config.url,
  };
}

const nonEmptyLines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * The form's fields, validated and packed into the shape `PUT /api/settings`
 * accepts — or a human-readable error if something is missing or malformed.
 * Pure so the validation rules can be tested without mounting the page.
 */
export function fromForm(form: McpForm): McpServerConfig | { error: string } {
  const name = form.name.trim();
  if (name === "") return { error: "名称不能为空" };

  if (form.kind === "stdio") {
    const command = form.command.trim();
    if (command === "") return { error: "可执行文件不能为空" };
    const args = nonEmptyLines(form.argsText);
    const env: Record<string, string> = {};
    for (const line of nonEmptyLines(form.envText)) {
      const at = line.indexOf("=");
      if (at <= 0) return { error: `环境变量格式错误："${line}"，应为 KEY=VALUE` };
      env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    return {
      name,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  const url = form.url.trim();
  if (url === "") return { error: "URL 不能为空" };
  return { name, url, ...(form.kind === "sse" ? { transport: "sse" as const } : {}) };
}
