/**
 * Node preload that keeps every TCP server inside a local sandbox session bound
 * to loopback.
 *
 * The official harness bridges hardcode `new WebSocketServer({ port, host:
 * "0.0.0.0" })`. We do not patch bridge source (it breaks on every upgrade);
 * instead `createLocalSandboxSession({ loopbackOnly: true })` injects
 * `NODE_OPTIONS=--import=<this file>` so the wildcard bind address is rewritten
 * to `127.0.0.1` before the socket is created.
 *
 * Loaded through `--import`, so it must stay side-effect only and dependency
 * free.
 */
import net from "node:net";

const LOOPBACK = "127.0.0.1";

/** Wildcard bind addresses, i.e. "every interface on this machine". */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"]);

function isWildcard(host: unknown): boolean {
  return typeof host === "string" && WILDCARD_HOSTS.has(host.trim());
}

type ListenArgs = readonly unknown[];

/**
 * Rewrites the bind address of a `net.Server#listen` argument list. Handles the
 * option-object form and the positional `(port, host, ...)` form; handle and
 * unix-socket-path forms are left untouched.
 */
export function rewriteListenArguments(args: ListenArgs): unknown[] {
  const next = [...args];
  const first = next[0];

  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    const options = first as { port?: unknown; host?: unknown; path?: unknown; fd?: unknown };
    if (options.path != null || options.fd != null) return next;
    if (isWildcard(options.host)) {
      next[0] = { ...options, host: LOOPBACK };
    } else if (options.host === undefined && typeof options.port === "number") {
      // An omitted host binds every interface just like an explicit wildcard.
      next[0] = { ...options, host: LOOPBACK };
    }
    return next;
  }

  if (typeof first === "number") {
    // `listen(port[, host[, backlog]][, callback])`. An omitted or wildcard host
    // binds every interface; anything else is already an explicit address.
    if (isWildcard(next[1])) next[1] = LOOPBACK;
    else if (next.length === 1) next.push(LOOPBACK);
    else if (next[1] === undefined) next[1] = LOOPBACK;
    else if (typeof next[1] !== "string") next.splice(1, 0, LOOPBACK);
  }

  return next;
}

const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function loopbackListen(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  return (listen as (...a: unknown[]) => net.Server).apply(
    this,
    rewriteListenArguments(args),
  );
} as typeof net.Server.prototype.listen;
