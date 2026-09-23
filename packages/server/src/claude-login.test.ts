import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizationUrl, createClaudeLogin } from "./claude-login.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(source: string, timeout = 2000) {
  const dir = await mkdtemp(join(tmpdir(), "vgent-login-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "claude");
  await writeFile(command, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  const login = createClaudeLogin({ command: async () => command, timeout });
  cleanup.push(login.cancel);
  return login;
}

describe("Claude browser login", () => {
  it("runs the official login arguments and exposes only the authorization link", async () => {
    const login = await fixture(`
      if (process.argv.slice(2).join(' ') !== 'auth login --claudeai') process.exit(2);
      console.log('private CLI output');
      console.log('https://claude.ai/oauth/authorize?state=test&client_id=test');
      setTimeout(() => process.exit(0), 400);
    `);
    expect((await login.start()).state).toBe("running");
    await expect.poll(() => login.status().url, { interval: 10, timeout: 1500 }).toBe("https://claude.ai/oauth/authorize?state=test&client_id=test");
    expect(JSON.stringify(login.status())).not.toContain("private");
    await expect.poll(() => login.status().state, { timeout: 3000 }).toBe("succeeded");
  });

  it("deduplicates clicks while resolving the CLI and cancels a pending launch", async () => {
    let resolve!: (command: string) => void;
    let calls = 0;
    const login = createClaudeLogin({ command: () => { calls++; return new Promise((done) => { resolve = done; }); } });
    cleanup.push(login.cancel);
    const first = login.start();
    expect(await login.start()).toEqual({ state: "running" });
    expect(calls).toBe(1);
    login.cancel();
    resolve("/nonexistent/claude");
    expect(await first).toEqual({ state: "idle" });
  });

  it("reports a missing CLI without leaking command output", async () => {
    const login = createClaudeLogin({ command: async () => "/nonexistent-vgent-test/claude" });
    cleanup.push(login.cancel);
    await login.start();
    await expect.poll(() => login.status().state).toBe("failed");
    expect(login.status().error).toContain("找不到 Claude Code");
  });

  it("times out and cancels its own login child", async () => {
    const login = await fixture("setInterval(() => {}, 1000)", 100);
    await login.start();
    await expect.poll(() => login.status().state).toBe("failed");
    await login.start();
    login.cancel();
    expect(login.status()).toEqual({ state: "idle" });
  });

  it("rejects arbitrary output URLs", () => {
    expect(authorizationUrl("https://evil.example/oauth/authorize?code=secret")).toBeUndefined();
    expect(authorizationUrl("https://claude.ai/not-oauth?token=secret")).toBeUndefined();
    expect(authorizationUrl("https://claude.ai.evil.example/oauth/authorize")).toBeUndefined();
  });
});
