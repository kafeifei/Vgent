import { createServer, request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { REMOTE_REQUEST_HEADER } from "./policy.js";

// This marker carries no authority. Dev Tunnels authenticates the owner before
// forwarding, and only this private gateway adds the local server's token.
export const REMOTE_SESSION = "vgent-remote-session";
const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function cleanHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connection = String(headers.connection ?? "").split(",").map((key) => key.trim().toLowerCase());
  for (const key of Object.keys(result)) {
    if (["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
      "authorization", "proxy-authorization", "proxy-authenticate", "x-tunnel-authorization", "x-vgent-token",
      "cookie", "set-cookie", "forwarded", ...connection].includes(key) || key.startsWith("x-forwarded-") || key.startsWith("access-control-")) {
      delete result[key];
    }
  }
  return result;
}

/** A dedicated loopback listener exposed only through a confirmed private relay. */
export function createWebEntry(options: {
  backend(): Promise<{ url: string; token: string }>;
  preferredPort?: number | undefined;
  remoteOrigin(): string | undefined;
}) {
  const sockets = new Set<Socket>();
  const upstreams = new Set<ClientRequest>();
  let server: ReturnType<typeof createServer> | undefined;
  let starting: Promise<{ url: string }> | undefined;
  let stopping: Promise<void> | undefined;

  const start = () => starting ??= (async () => {
    const backend = await options.backend();
    const target = new URL(backend.url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
      throw new Error("Remote gateway requires the local Vgent server");
    }
    server = createServer((incoming, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const forbidden = () => send(403, { error: { code: "remote_forbidden", message: "此操作需在主机上完成" } });
      const origin = options.remoteOrigin();
      // Never derive trust from Forwarded headers or an unconfirmed hostname.
      if (!origin || incoming.headers.host !== new URL(origin).host) {
        send(421, { error: { code: "forbidden_host", message: "远程地址不匹配" } });
        return;
      }
      const raw = incoming.url ?? "/";
      if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(raw)) return forbidden();
      const url = new URL(raw, origin);
      let path: string;
      try { path = decodeURIComponent(url.pathname); } catch { return forbidden(); }
      // Reject ambiguous encoded paths before applying the control-route boundary.
      if (/%(?:2f|5c|2e|25)/i.test(url.pathname) || /[\\\u0000-\u001f\u007f]/.test(path)) return forbidden();
      const api = path === "/api" || path.startsWith("/api/");
      const navigation = !api && ["GET", "HEAD"].includes(incoming.method ?? "GET");
      const site = incoming.headers["sec-fetch-site"];
      if (incoming.headers.origin != null && incoming.headers.origin !== origin) return forbidden();
      if (!navigation && (site === "cross-site" || (site === "same-site" && incoming.headers.origin !== origin))) return forbidden();
      if (incoming.method === "OPTIONS") return forbidden();
      if (path === "/api/remote/session" && incoming.method === "GET") {
        send(200, { token: REMOTE_SESSION });
        return;
      }
      if (path === "/api/remote" || path.startsWith("/api/remote/")) return forbidden();
      // The host's accounts can be read from afar, not signed in, out or switched.
      if (path.startsWith("/api/accounts/")) return forbidden();
      if (path === "/api/projects/pick") {
        send(409, { error: { code: "picker_unavailable", message: "远程连接请填写主机上的路径" } });
        return;
      }
      // A browser marker must never become a local credential in URLs or logs.
      url.searchParams.delete("token");
      const headers = cleanHeaders(incoming.headers);
      headers.host = target.host;
      headers["x-vgent-token"] = backend.token;
      // Whatever the remote side sent, this is what the local API sees: the mark
      // that puts the request under the remote policy (see `policy.ts`).
      headers[REMOTE_REQUEST_HEADER] = "1";
      if (headers.origin) headers.origin = target.origin;
      const upstream = request({
        hostname: target.hostname, port: target.port, method: incoming.method,
        path: url.pathname + url.search, headers,
      });
      upstreams.add(upstream);
      upstream.once("close", () => upstreams.delete(upstream));
      upstream.on("response", (body) => {
        // Stream directly: buffering would break chat/SSE and large file transfers.
        response.writeHead(body.statusCode ?? 502, { ...cleanHeaders(body.headers), ...SECURITY_HEADERS });
        body.on("error", () => response.destroy());
        body.on("aborted", () => response.destroy());
        body.pipe(response);
      });
      upstream.on("error", () => {
        if (response.headersSent) response.destroy();
        else send(502, { error: { code: "remote_upstream", message: "主机服务暂时不可用" } });
      });
      incoming.once("aborted", () => upstream.destroy());
      response.once("close", () => upstream.destroy());
      incoming.pipe(upstream);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (_incoming, socket) => socket.destroy());
    const listen = (port: number) => new Promise<void>((resolve, reject) => {
      const error = (err: Error) => { server!.off("listening", ready); reject(err); };
      const ready = () => { server!.off("error", error); resolve(); };
      server!.once("error", error);
      server!.once("listening", ready);
      server!.listen(port, "127.0.0.1");
    });
    await listen(options.preferredPort ?? 0).catch(async (error: NodeJS.ErrnoException) => {
      if (!options.preferredPort || error.code !== "EADDRINUSE") throw error;
      await listen(0);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Remote gateway did not bind");
    return { url: `http://127.0.0.1:${address.port}` };
  })();

  const stop = () => stopping ??= (async () => {
    await starting?.catch(() => {});
    upstreams.forEach((upstream) => upstream.destroy());
    sockets.forEach((socket) => socket.destroy());
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  })();
  return { start, stop };
}
