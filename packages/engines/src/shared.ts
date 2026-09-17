import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Directory holding a `pnpm` executable. Every harness adapter's bootstrap
 * runs `pnpm install --frozen-lockfile`, and the sandbox inherits no PATH
 * from this process, so the directory has to be put on it explicitly.
 */
export function resolvePnpmDir(): string {
  const found = execFileSync("/bin/sh", ["-c", "command -v pnpm || true"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (found) return dirname(found);
  throw new Error("pnpm was not found on PATH; the harness bridge bootstrap needs it.");
}

export async function ensureDirectory(path: string, mode?: number): Promise<string> {
  await mkdir(path, { recursive: true, ...(mode != null ? { mode } : {}) });
  return path;
}

/** Resolves and validates that `repoPath` is a directory, for a given engine's error text. */
export async function resolveRepoPath(repoPath: string, engineName: string): Promise<string> {
  const resolved = resolve(repoPath);
  if (!(await stat(resolved).catch(() => null))?.isDirectory()) {
    throw new Error(`${engineName} engine repoPath is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * `HarnessAgent` always composes `sessionWorkDir` underneath the sandbox's
 * default working directory, and `sandboxConfig.workDir` must stay inside it.
 * Overriding the adapter entry point is the only way to point the runtime at
 * a repository outside the sandbox directory.
 */
export function withRepoWorkDir<H extends { doStart: (startOptions: any) => any }>(harness: H, repoPath: string): H {
  return {
    ...harness,
    doStart: (startOptions: Parameters<H["doStart"]>[0]) => harness.doStart({ ...startOptions, sessionWorkDir: repoPath }),
  };
}
