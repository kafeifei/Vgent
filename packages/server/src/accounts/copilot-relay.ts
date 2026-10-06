import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { COPILOT_API } from "@vgent/providers";
import { isAccountId, kindOfAccount } from "./spec.js";
import type { AccountId } from "./types.js";

/** Where an engine process sends one account's Copilot requests, and the key it sends them with. */
export interface CopilotEndpoint { baseURL: string; apiKey: string }

/** What the relay passes on of a client's headers; Copilot's own and the credential are the account's to add. */
const FORWARDED_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];

/** What it keeps of Copilot's reply headers: not the framing, which this hop redoes, nor an encoding `fetch` has already undone. */
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

/** The most a request may carry: screenshots ride along base64-encoded. */
const MAX_BODY = 64 * 1024 * 1024;

const sameKey = (provided: string, expected: string) => {
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Both error shapes in one: Anthropic clients read `type`, OpenAI ones `error.message`. */
function fail(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(FORWARDED_HEADERS.flatMap((name) => (typeof headers[name] === "string" ? [[name, headers[name]]] : [])));
}

/**
 * Copilot's Responses stream names one output item afresh on every event — a
 * new encrypted id on each delta of the same reasoning summary. A client that
 * pieces an item together by its id (OpenCode's) then finds a delta for an item
 * it never saw start. Each item keeps the id it was announced with here, in
 * its events and in the finished response; Copilot takes that id back on the
 * next request like any of the others.
 */
export function steadyItemIds(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const ids = new Map<number, string>();
  let pending = "";
  const rewrite = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line.slice(5)) as Record<string, unknown>; } catch { return line; }
    if (typeof event !== "object" || event == null) return line;
    const item = event.item as Record<string, unknown> | undefined;
    const index = event.output_index;
    if (event.type === "response.output_item.added" && typeof index === "number" && typeof item?.id === "string") { ids.set(index, item.id); return line; }
    let changed = false;
    const id = typeof index === "number" ? ids.get(index) : undefined;
    if (id != null && typeof event.item_id === "string" && event.item_id !== id) { event.item_id = id; changed = true; }
    if (id != null && typeof item?.id === "string" && item.id !== id) { item.id = id; changed = true; }
    const output = (event.response as Record<string, unknown> | undefined)?.output;
    if (Array.isArray(output)) {
      output.forEach((entry: Record<string, unknown>, at) => {
        const steady = ids.get(at);
        if (steady != null && typeof entry?.id === "string" && entry.id !== steady) { entry.id = steady; changed = true; }
      });
    }
    return changed ? `data: ${JSON.stringify(event)}` : line;
  };
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(rewrite).join("\n")}\n`));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending !== "") controller.enqueue(encoder.encode(rewrite(pending)));
    },
  });
}

/**
 * Copilot for the engines that run as processes of their own — Claude Code,
 * Codex, OpenCode. Each takes an endpoint and a key, while Copilot wants a
 * token that lasts minutes and a set of client headers on every request. So
 * the server listens on loopback, on a port of its choosing, with a key of its
 * own, and passes `/<account>/<path>` on to that account's Copilot through the
 * same fetch the in-house engine uses (`CopilotAccess.fetch`): the token, the
 * account's API host and the headers are added there.
 *
 * Started on first use. The key lives as long as this process: an engine
 * still running after a restart has the old one, and its next request fails.
 */
export function createCopilotRelay(accessOf: (id: AccountId) => { fetch: typeof fetch }) {
  const key = randomBytes(32).toString("base64url");
  let server: Server | undefined;
  let listening: Promise<string> | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const presented = bearer ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined);
    if (presented == null || !sameKey(presented, key)) return fail(res, 401, "Unknown key");
    const url = new URL(req.url ?? "/", "http://relay");
    const [, account = "", ...rest] = url.pathname.split("/");
    if (!isAccountId(account) || kindOfAccount(account) !== "github") return fail(res, 404, "Unknown account");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    const upstream = await accessOf(account).fetch(`${COPILOT_API}/${rest.join("/")}`, {
      method: req.method ?? "GET",
      headers: forwardedHeaders(req.headers),
      ...(body != null ? { body } : {}),
      signal: abort.signal,
    });
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, name) => { if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value; });
    res.writeHead(upstream.status, headers);
    if (upstream.body == null) return void res.end();
    const streamed = rest.join("/") === "responses" && upstream.headers.get("content-type")?.includes("text/event-stream") === true;
    const reply = streamed ? upstream.body.pipeThrough(steadyItemIds()) : upstream.body;
    Readable.fromWeb(reply as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
  }

  const listen = () => new Promise<string>((resolve, reject) => {
    const created = createServer((req, res) => {
      handle(req, res).catch((error: unknown) => {
        if (res.headersSent) res.destroy();
        else fail(res, 502, error instanceof Error ? error.message : String(error));
      });
    });
    created.once("error", reject);
    created.listen(0, "127.0.0.1", () => {
      created.unref();
      server = created;
      const address = created.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`);
    });
  });

  return {
    /** The relay's address for one account, starting it when nothing has asked before. */
    async endpoint(id: AccountId): Promise<CopilotEndpoint> {
      const origin = await (listening ??= listen().catch((error: unknown) => { listening = undefined; throw error; }));
      return { baseURL: `${origin}/${id}`, apiKey: key };
    },
    async close() {
      const running = server;
      server = undefined;
      listening = undefined;
      if (running == null) return;
      running.closeAllConnections();
      await new Promise<void>((resolve) => running.close(() => resolve()));
    },
  };
}
