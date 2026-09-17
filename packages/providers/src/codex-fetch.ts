import { isRecord } from "@ai-sdk/provider-utils";
import type { CodexTokenProvider } from "./codex-credentials.js";
import { CHATGPT_CODEX_BASE_URL } from "./codex-credentials.js";

type FetchLike = typeof globalThis.fetch;

export type CodexFetchOptions = {
  readonly tokens: Pick<CodexTokenProvider, "getAccessToken">;
  readonly fetch?: FetchLike;
  /** Client identifier the endpoint expects; Codex CLI sends `codex_cli_rs`. */
  readonly originator?: string;
  readonly baseURL?: string;
};

/**
 * Body rewrites the ChatGPT Codex endpoint needs, mirroring what the Codex CLI
 * sends: no server-side response storage, encrypted reasoning carried in the
 * request instead, system/developer turns hoisted into `instructions`.
 */
export function prepareCodexResponsesBody(raw: string): { body: string; stream: boolean } {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) return { body: raw, stream: false };
  const request: Record<string, unknown> = { ...parsed };

  const stream = request.stream === true;
  // The endpoint is stream-only; a non-streaming call is turned into a stream
  // here and folded back into a single JSON response below.
  request.stream = true;
  request.store = false;
  delete request.max_output_tokens;

  const include = Array.isArray(request.include) ? [...(request.include as unknown[])] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  request.include = include;

  if (Array.isArray(request.input)) {
    const input = request.input as unknown[];
    const instructions: string[] = [];
    let index = 0;
    while (index < input.length) {
      const text = instructionTextOf(input[index]);
      if (text == null) break;
      instructions.push(text);
      index += 1;
    }
    const rest = index > 0 ? input.slice(index) : input;
    if (instructions.length > 0) {
      request.instructions = [
        typeof request.instructions === "string" ? request.instructions : undefined,
        ...instructions,
      ]
        .filter((value): value is string => value != null)
        .join("\n\n");
    }
    // Stateless mode: reasoning items must travel by encrypted content, not id.
    request.input = rest.map((item) => {
      if (
        !isRecord(item) ||
        item.type !== "reasoning" ||
        typeof item.encrypted_content !== "string" ||
        item.encrypted_content.length === 0 ||
        !("id" in item)
      ) {
        return item;
      }
      const { id: _id, ...stateless } = item;
      return stateless;
    });
  }

  if (Array.isArray(request.tools)) {
    request.tools = (request.tools as unknown[]).map((tool) =>
      isRecord(tool) && tool.type === "function" ? { ...tool, strict: null } : tool,
    );
  }

  return { body: JSON.stringify(request), stream };
}

function instructionTextOf(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  if (item.role !== "developer" && item.role !== "system") return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  const parts = (item.content as unknown[]).map((part) =>
    isRecord(part) && typeof part.text === "string" ? part.text : undefined,
  );
  return parts.every((part) => part != null) ? parts.join("\n") : undefined;
}

function eventDataOf(block: string): string | undefined {
  const lines = block
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => {
      const data = line.slice("data:".length);
      return data.startsWith(" ") ? data.slice(1) : data;
    });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * The ChatGPT endpoint emits `response.done` where the public Responses API
 * emits `response.completed`; the AI SDK parser only knows the latter.
 */
function normalizeEventBlock(block: string): string {
  const data = eventDataOf(block);
  if (data == null) return `${block}\n\n`;
  const trimmed = data.trim();
  if (trimmed === "" || trimmed === "[DONE]") return `data: ${trimmed}\n\n`;
  try {
    const event: unknown = JSON.parse(data);
    if (isRecord(event) && event.type === "response.done") {
      return `data: ${JSON.stringify({ ...event, type: "response.completed" })}\n\n`;
    }
    return `data: ${data}\n\n`;
  } catch {
    return `data: ${data}\n\n`;
  }
}

function normalizeEventStream(response: Response): Response {
  const body = response.body;
  // The endpoint answers without a content-type, so the stream is identified by
  // the request rather than the response header.
  if (body == null || !response.ok) return response;
  let buffered = "";
  const stream = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          buffered += chunk;
          let boundary = /\r?\n\r?\n/.exec(buffered);
          while (boundary != null) {
            controller.enqueue(normalizeEventBlock(buffered.slice(0, boundary.index)));
            buffered = buffered.slice(boundary.index + boundary[0].length);
            boundary = /\r?\n\r?\n/.exec(buffered);
          }
        },
        flush(controller) {
          if (buffered !== "") controller.enqueue(normalizeEventBlock(buffered));
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/event-stream");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Folds the forced event stream back into the single JSON body that
 * `doGenerate` expects.
 *
 * The terminal event carries the response envelope (status, usage, model) but
 * this endpoint leaves its `output` array empty — the items only ever arrive as
 * `response.output_item.done` events — so the array is rebuilt from those.
 */
async function collectStreamIntoResponse(response: Response): Promise<Response> {
  const text = await response.text();
  let final: Record<string, unknown> | undefined;
  const outputItems = new Map<number, unknown>();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = eventDataOf(block);
    if (data == null || data.trim() === "" || data.trim() === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      return new Response(JSON.stringify({ error: event }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (event.type === "response.output_item.done" && isRecord(event.item)) {
      outputItems.set(typeof event.output_index === "number" ? event.output_index : outputItems.size, event.item);
      continue;
    }
    if (
      (event.type === "response.completed" ||
        event.type === "response.done" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete") &&
      isRecord(event.response)
    ) {
      final = event.response;
    }
  }
  if (final == null) {
    // Not an event stream we understand (e.g. an error body) — hand it back as-is.
    const contentType = response.headers.get("content-type");
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      ...(contentType == null ? {} : { headers: { "content-type": contentType } }),
    });
  }
  const existingOutput = Array.isArray(final.output) ? (final.output as unknown[]) : [];
  const output =
    existingOutput.length > 0
      ? existingOutput
      : [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  return new Response(JSON.stringify({ ...final, output }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function requestUrlOf(input: Parameters<FetchLike>[0]): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

/**
 * Wraps fetch so every request carries the subscription bearer token and the
 * ChatGPT account header. Refuses to send credentials anywhere but the Codex
 * endpoint, and retries once on a 401 with a freshly refreshed token.
 */
export function createCodexFetch(options: CodexFetchOptions): FetchLike {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const originator = options.originator ?? "codex_cli_rs";
  const baseURL = new URL(options.baseURL ?? CHATGPT_CODEX_BASE_URL);

  return async function codexFetch(input, init) {
    const url = requestUrlOf(input);
    if (url.origin !== baseURL.origin || !url.pathname.startsWith(baseURL.pathname)) {
      throw new Error(`Refusing to send Codex credentials to ${url.origin}${url.pathname}`);
    }
    const isResponses = url.pathname.endsWith("/responses");

    const prepared =
      isResponses && typeof init?.body === "string" ? prepareCodexResponsesBody(init.body) : undefined;
    const wantsStream = prepared?.stream ?? false;

    const send = async (forceRefresh: boolean): Promise<Response> => {
      const token = await options.tokens.getAccessToken({ forceRefresh });
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${token.accessToken}`);
      if (token.accountId != null) headers.set("chatgpt-account-id", token.accountId);
      headers.set("originator", originator);
      if (isResponses) {
        headers.set("openai-beta", "responses=experimental");
        headers.set("accept", "text/event-stream");
      }
      const requestInit: RequestInit = { ...init, headers };
      if (prepared != null) requestInit.body = prepared.body;
      return baseFetch(input, requestInit);
    };

    let response = await send(false);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(true);
    }
    if (prepared == null) return response;
    return wantsStream ? normalizeEventStream(response) : collectStreamIntoResponse(response);
  };
}
