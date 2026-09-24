import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, expect, test } from "vitest";
import { createApp } from "../app.js";
import { createEngineRegistry } from "../engines/registry.js";
import { createWebEntry, REMOTE_SESSION } from "./gateway.js";

const TOKEN = "private-local-token-never-in-browser";
const ORIGIN = "https://vgent-test-1234.usw2.devtunnels.ms";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function http(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)) }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers as Record<string, string> })));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "vgent-remote-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Vgent test</title>");
  const instance = createApp({ dataDir: directory, token: TOKEN, webDist: directory,
    catalogFetch: async () => { throw new Error("offline"); },
    registry: createEngineRegistry({ "claude-code": {
      async create() {
        return {
          async stream() {
            return { stream: ReadableStream.from((async function* () {
              yield { type: "start" as const };
              yield { type: "text-start" as const, id: "t" };
              yield { type: "text-delta" as const, id: "t", text: "REMOTE_STREAM_OK" };
              yield { type: "text-end" as const, id: "t" };
            })()) };
          },
          hasUnfinishedTurn: () => false, async destroy() {}, async finish() {},
        };
      },
    } }),
  });
  cleanup.push(() => instance.shutdown());
  const server = serve({ fetch: instance.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address() as { port: number };
  const local = `http://127.0.0.1:${address.port}`;
  let remoteOrigin: string | undefined = ORIGIN;
  const gateway = createWebEntry({ backend: async () => ({ url: local, token: TOKEN }), remoteOrigin: () => remoteOrigin });
  const { url } = await gateway.start();
  cleanup.push(gateway.stop);
  const send = (path: string, init: RequestInit = {}) => http(url + path, { ...init, headers: { host: new URL(ORIGIN).host, origin: ORIGIN, ...init.headers } });
  const post = (path: string, body: unknown) => send(path, { method: "POST", headers: { "content-type": "application/json", "x-vgent-token": REMOTE_SESSION }, body: JSON.stringify(body) });
  return { gateway, url, local, send, post, revokeOrigin: () => { remoteOrigin = undefined; } };
}

test("serves the workbench and API through the gateway without disclosing local credentials", async () => {
  const { send, local } = await fixture();
  expect(await (await send("/")).text()).toContain("Vgent test");
  const bootstrap = await send("/api/remote/session");
  expect(await bootstrap.json()).toEqual({ token: REMOTE_SESSION });
  expect(bootstrap.headers.get("cache-control")).toBe("no-store");
  expect((await send("/api/projects", { headers: { authorization: "Bearer attacker", cookie: "unrelated-secret" } })).status).toBe(200);
  expect((await fetch(local + "/api/projects", { headers: { "x-vgent-token": REMOTE_SESSION } })).status).toBe(401);
  expect((await http(local + "/api/projects", { headers: { host: new URL(ORIGIN).host, "x-vgent-token": TOKEN } })).status).toBe(403);
});

test("refuses wrong hosts, cross-origin controls, encoded control routes and remote administration", async () => {
  const { send, url, revokeOrigin } = await fixture();
  expect((await fetch(url + "/api/projects")).status).toBe(421);
  expect((await send("/api/projects", { headers: { origin: "https://evil.example" } })).status).toBe(403);
  expect((await send("/api/projects", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  for (const path of ["/api/remote", "/api/remote/foo", "/api/%72emote", "/api/remote%2ffoo", "//evil.example/api/projects"]) {
    expect((await send(path)).status).toBe(403);
  }
  expect((await send("/api/projects/pick", { method: "POST" })).status).toBe(409);
  revokeOrigin();
  expect((await send("/api/projects")).status).toBe(421);
});

test("creates a task and persists a streamed reply through real gateway and Hono sockets", async () => {
  const { send, post } = await fixture();
  const created = await post("/api/threads", { projectId: "no-project", engine: "claude-code", title: "remote test" });
  expect(created.status).toBe(200);
  const thread = await created.json() as { id: string };
  const response = await post(`/api/chat/${thread.id}`, { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const stream = await response.text();
  expect(stream).toContain("REMOTE_STREAM_OK");
  expect(stream).not.toContain(TOKEN);
  await expect.poll(async () => (await send(`/api/threads/${thread.id}`)).text()).toContain("REMOTE_STREAM_OK");
});

test("stopping remote access closes a live SSE stream and leaves the local service available", async () => {
  const { gateway, url, local } = await fixture();
  const incoming = request(url + "/api/state?token=" + REMOTE_SESSION, { headers: { host: new URL(ORIGIN).host } });
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    incoming.on("response", resolve); incoming.on("error", reject); incoming.end();
  });
  expect(response.statusCode).toBe(200);
  response.on("error", () => {});
  const first = await new Promise<string>((resolve) => response.once("data", (chunk: Buffer) => resolve(chunk.toString())));
  expect(first).toContain("event: state");
  const closed = new Promise<void>((resolve) => response.once("close", resolve));
  await gateway.stop();
  await closed;
  expect((await fetch(local + "/api/projects", { headers: { "x-vgent-token": TOKEN } })).status).toBe(200);
});
