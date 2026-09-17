import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BOOTSTRAP_MARKER, createLocalSandboxProvider } from "./provider.js";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "vgent-local-provider-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, provider: createLocalSandboxProvider({ cwd, allowDynamicPorts: true }) };
}

describe("createLocalSandboxProvider", () => {
  it("declares the harness sandbox v1 contract", async () => {
    const { provider } = await fixture();
    expect(provider.specificationVersion).toBe("harness-sandbox-v1");
    expect(provider.providerId).toBe("vgent-local");
  });

  it("runs onFirstCreate once per cwd and marks it on disk", async () => {
    const { cwd, provider } = await fixture();
    const bootstrapped: string[] = [];
    const first = await provider.createSession({
      sessionId: "session-a",
      onFirstCreate: async session => {
        bootstrapped.push(session.description);
        await session.writeTextFile({ path: "installed", content: "1" });
      },
    });
    expect(first.id).toBe("session-a");
    expect(first.defaultWorkingDirectory).toBe(await realCwd(cwd));
    expect(bootstrapped).toHaveLength(1);
    await expect(access(join(cwd, BOOTSTRAP_MARKER))).resolves.toBeUndefined();
    await first.destroy();

    const second = await provider.createSession({
      sessionId: "session-b",
      onFirstCreate: async () => {
        bootstrapped.push("second");
      },
    });
    expect(bootstrapped).toHaveLength(1);
    await second.destroy();
  });

  it("names the session randomly when no sessionId is supplied", async () => {
    const { provider } = await fixture();
    const session = await provider.createSession();
    onTestFinished(() => session.destroy());
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("resumes onto the same directory without re-running onFirstCreate", async () => {
    const { cwd, provider } = await fixture();
    const resumed = await provider.resumeSession!({ sessionId: "session-a" });
    onTestFinished(() => resumed.destroy());
    expect(resumed.id).toBe("session-a");
    expect(resumed.defaultWorkingDirectory).toBe(await realCwd(cwd));
    await expect(access(join(cwd, BOOTSTRAP_MARKER))).rejects.toThrow();
  });
});

async function realCwd(cwd: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(cwd);
}
