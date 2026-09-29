import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type JsonObject = Record<string, unknown>;

export interface CodexNotification {
  method: string;
  params: JsonObject;
}

/** Resolve the CLI we package with the server, independent of the desktop app's PATH. */
function codexCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

/** One native Codex app-server process, scoped to one active Vgent turn. */
export class CodexAppServer {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #listeners = new Set<(event: CodexNotification) => void>();
  #nextId = 1;
  #buffer = "";
  #closed = false;
  #exit: Promise<void>;

  constructor(options: { cwd: string; env: NodeJS.ProcessEnv; modelCatalogPath?: string }) {
    // Model metadata is loaded when the process starts, before thread/start.
    const catalogArgs = options.modelCatalogPath == null ? [] : ["-c", `model_catalog_json=${JSON.stringify(options.modelCatalogPath)}`];
    this.#child = spawn(process.execPath, [codexCli(), "--enable", "fast_mode", ...catalogArgs, "app-server", "--stdio"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // The package shim spawns the native binary. Keep both in one process
      // group so stopping a Vgent turn also stops its Codex runtime.
      detached: process.platform !== "win32",
    });
    this.#exit = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        const error = new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`);
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.#pending.clear();
        for (const listener of this.#listeners) listener({ method: "process/exited", params: { message: error.message } });
        resolve();
      });
    });
    this.#child.once("error", (error) => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.#pending.clear();
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#read(chunk));
    // stderr may contain runtime diagnostics or request details. It is never
    // forwarded into the task transcript or logged with credentials.
    this.#child.stderr.resume();
  }

  onNotification(listener: (event: CodexNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "Vgent", version: "0.1" } });
    this.notify("initialized");
  }

  request(method: string, params: JsonObject, timeoutMs = 120_000): Promise<JsonObject> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error != null) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  notify(method: string, params?: JsonObject): void {
    if (!this.#closed) this.#child.stdin.write(`${JSON.stringify({ method, ...(params == null ? {} : { params }) })}\n`);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const pid = this.#child.pid;
    if (pid != null && process.platform !== "win32") {
      try { process.kill(-pid, "SIGTERM"); } catch { this.#child.kill("SIGTERM"); }
    } else {
      this.#child.kill("SIGTERM");
    }
    await Promise.race([this.#exit, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    if (!this.#closed && pid != null && process.platform !== "win32") {
      try { process.kill(-pid, "SIGKILL"); } catch { this.#child.kill("SIGKILL"); }
    }
    await this.#exit;
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (line === "") continue;
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; } catch { continue; }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (pending == null) continue;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        const fault = message.error as JsonObject | undefined;
        if (fault != null) pending.reject(new Error(String(fault.message ?? "Codex request failed")));
        else pending.resolve((message.result as JsonObject | undefined) ?? {});
        continue;
      }
      if (typeof message.method === "string") {
        const event = { method: message.method, params: (message.params as JsonObject | undefined) ?? {} };
        for (const listener of this.#listeners) listener(event);
      }
    }
  }
}
