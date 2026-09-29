import { execFile, type ChildProcess } from "node:child_process";

/**
 * One vendor CLI signing in: `claude auth login`, `codex login`. The CLI owns
 * OAuth — it opens the browser and stores what it gets — and this only watches
 * for the authorization page it prints, so the app can offer the same link,
 * and for the process to end.
 */
export interface CliLogin {
  /** The authorization page, once the CLI has printed it. */
  url(): string | undefined;
  /** Resolves when the CLI exits 0, rejects otherwise. */
  done: Promise<void>;
  cancel(): void;
}

export function runCliLogin(options: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Picks the authorization page out of the output so far. */
  match(output: string): string | undefined;
  timeout?: number;
  /** Called when the link appears. */
  changed?: () => void;
  /** Test seam. */
  spawn?: typeof execFile;
}): CliLogin {
  let output = "";
  let url: string | undefined;
  let child: ChildProcess | undefined;
  const done = new Promise<void>((resolve, reject) => {
    child = (options.spawn ?? execFile)(options.command, [...options.args], {
      env: options.env,
      timeout: options.timeout ?? 5 * 60_000,
      maxBuffer: 256 * 1024,
    }, (error) => {
      child = undefined;
      if (error == null) resolve();
      else reject(error);
    });
    const read = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-32_768);
      const found = url ?? options.match(output);
      if (found != null && url == null) {
        url = found;
        options.changed?.();
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
  });
  // Whoever cancels first may never await it.
  done.catch(() => {});
  return {
    url: () => url,
    done,
    cancel: () => { child?.kill("SIGTERM"); child = undefined; },
  };
}

/** The first `https` URL on one of `hosts` whose path is `path`. */
export function authorizationLink(output: string, hosts: readonly string[], path: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      if (hosts.includes(url.hostname) && url.pathname === path) return url.href;
    } catch { /* A partial chunk is retried on the next one. */ }
  }
  return undefined;
}
