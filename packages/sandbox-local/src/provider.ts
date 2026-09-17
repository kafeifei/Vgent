import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { createLocalSandboxSession, type LocalSandboxOptions } from "./session.js";

export type LocalSandboxProviderOptions = Pick<
  LocalSandboxOptions,
  "cwd" | "env" | "pathExtensions" | "ports" | "allowDynamicPorts" | "loopbackOnly"
>;

/** Written into `cwd` once the first-create hook has run for that directory. */
export const BOOTSTRAP_MARKER = ".vgent-bootstrapped";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `HarnessV1SandboxProvider` backed by the host machine. Every session runs in
 * the same `cwd`, so `onFirstCreate` — where the harness installs its bridge
 * bootstrap — only runs until that directory carries the marker file.
 *
 * This is not a security boundary: processes run as the current user. Tool
 * permissions are enforced by `permissionMode` / `toolApproval` in the harness.
 */
export function createLocalSandboxProvider(options: LocalSandboxProviderOptions): HarnessV1SandboxProvider {
  const sessionOptions = (id: string): LocalSandboxOptions => ({ ...options, id });
  const markerPath = join(options.cwd, BOOTSTRAP_MARKER);

  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: "vgent-local",
    createSession: async ({ sessionId, onFirstCreate, abortSignal } = {}) => {
      const session = await createLocalSandboxSession(sessionOptions(sessionId ?? randomUUID()));
      if (onFirstCreate != null && !(await exists(markerPath))) {
        try {
          await onFirstCreate(session.restricted(), { ...(abortSignal ? { abortSignal } : {}) });
        } catch (error) {
          await session.destroy();
          throw error;
        }
        await writeFile(markerPath, "", { mode: 0o600 });
      }
      return session;
    },
    resumeSession: ({ sessionId }): Promise<HarnessV1NetworkSandboxSession> =>
      createLocalSandboxSession(sessionOptions(sessionId)),
  };
}
