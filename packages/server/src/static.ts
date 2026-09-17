import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

const noop = async (): Promise<void> => {};

/**
 * Serves a built `apps/web` from the same origin as `/api`, so the desktop
 * shell (and anyone running `--web-dist`) needs no second server: the token in
 * `#token=` and the relative `/api/...` calls both stay same-origin.
 *
 * Registered *after* the API routes, so a matched `/api` handler always wins;
 * the prefix guard only covers `/api` paths that no handler claims.
 */
export function registerStatic(app: Hono, webDist: string, isLoopbackHost: (hostname: string) => boolean): void {
  const file = serveStatic({ root: webDist });
  // A Vite SPA owns every route it renders, so anything that is not a file is index.html.
  const index = serveStatic({ root: webDist, path: "index.html" });

  app.use("*", async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isLoopbackHost(host.replace(/:\d+$/, ""))) {
      return c.json({ error: { code: "forbidden_host", message: "只接受来自本机的请求" } }, 403);
    }
    // `serveStatic` answers with a Response or falls through to its `next`.
    return (await file(c, noop)) ?? (await index(c, noop)) ?? next();
  });
}
