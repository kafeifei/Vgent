import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";

/**
 * Directory holding a `pnpm` executable. Every harness adapter's bootstrap
 * runs `pnpm install --frozen-lockfile`, and the sandbox inherits no PATH
 * from this process, so the directory has to be put on it explicitly.
 */
export function resolvePnpmDir(): string {
  const managed = process.env.VGENT_PNPM_DIR;
  if (managed != null && existsSync(join(managed, "pnpm"))) return managed;
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

type SandboxSession = Awaited<ReturnType<HarnessV1SandboxProvider["createSession"]>>;

export interface TrackedSandbox {
  /** Drop-in replacement for the provider, recording every session it hands out. */
  sandbox: HarnessV1SandboxProvider;
  /** Stop every session handed out so far. For the failure path of `createSession()`. */
  stopHandedOut(): Promise<void>;
  /** Forget what was handed out, once the harness owns the session and will stop it itself. */
  forget(): void;
}

/**
 * Wraps a sandbox provider so a failed `HarnessAgent.createSession()` cannot
 * leak a sandbox session.
 *
 * Neither `HarnessAgent` nor `createLocalSandboxProvider` exposes a disposal
 * API — the only thing a failed `createSession()` can leak is a sandbox session
 * (a real host process group) the harness did not get far enough to stop
 * itself. `stop()` on the local sandbox is memoized, so stopping a session the
 * harness already cleaned up is a no-op rather than a double kill.
 */
export function trackSandboxSessions(provider: HarnessV1SandboxProvider): TrackedSandbox {
  const handedOut = new Set<SandboxSession>();
  const sandbox: HarnessV1SandboxProvider = {
    ...provider,
    createSession: async (createOptions) => {
      const created = await provider.createSession(createOptions);
      handedOut.add(created);
      return created;
    },
    ...(provider.resumeSession != null
      ? {
          resumeSession: async (resumeOptions: Parameters<NonNullable<HarnessV1SandboxProvider["resumeSession"]>>[0]) => {
            const resumed = await provider.resumeSession!(resumeOptions);
            handedOut.add(resumed);
            return resumed;
          },
        }
      : {}),
  };

  return {
    sandbox,
    async stopHandedOut() {
      for (const orphan of handedOut) await Promise.resolve(orphan.stop()).catch(() => {});
      handedOut.clear();
    },
    forget: () => handedOut.clear(),
  };
}
