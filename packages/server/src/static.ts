import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";

type Asset = { body: Uint8Array<ArrayBuffer>; type: string };

/**
 * Every file under `webDist`, read once, keyed by URL path (`/assets/x.js`).
 *
 * Installing a new Vgent.app swaps the bundle under a running instance, and
 * the page already open still asks for its own build's lazy chunks (Shiki
 * grammars, Streamdown's highlighter) by their old hashed names. Reading the
 * directory per request served the new build's `index.html` for those, the
 * `import()` failed, and the window went blank at the first code block. A
 * server now serves exactly the web build it was started with.
 */
function readWebDist(webDist: string): Map<string, Asset> {
  const files = new Map<string, Asset>();
  for (const entry of readdirSync(webDist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(`/${relative(webDist, path).split(sep).join("/")}`, {
      body: readFileSync(path),
      type: getMimeType(path) ?? "application/octet-stream",
    });
  }
  return files;
}

/**
 * Serves a built `apps/web` from the same origin as `/api`, so the desktop
 * shell (and anyone running `--web-dist`) needs no second server: the token in
 * `#token=` and the relative `/api/...` calls both stay same-origin.
 *
 * Registered *after* the API routes, so a matched `/api` handler always wins;
 * the prefix guard only covers `/api` paths that no handler claims.
 */
export function registerStatic(app: Hono, webDist: string, isLoopbackHost: (hostname: string) => boolean): void {
  const files = readWebDist(webDist);
  const index = files.get("/index.html");

  app.use("*", async (c, next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    // Hono runs HEAD as GET and drops the body itself.
    if (c.req.method !== "GET") return next();
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!isLoopbackHost(host.replace(/:\d+$/, ""))) {
      return c.json({ error: { code: "forbidden_host", message: "只接受来自本机的请求" } }, 403);
    }
    const file = files.get(c.req.path);
    if (file != null) return c.body(file.body, 200, { "content-type": file.type });
    // A missing chunk is a 404, never the SPA shell: HTML handed to `import()` fails as a parse error far from the cause.
    if (c.req.path.startsWith("/assets/")) return c.text("Not Found", 404);
    // A Vite SPA owns every route it renders, so anything that is not a file is index.html.
    if (index == null) return next();
    return c.body(index.body, 200, { "content-type": index.type, "cache-control": "no-cache" });
  });
}
