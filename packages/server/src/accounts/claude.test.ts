import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeHomeOf, claudeKeychainService, prepareClaudeHome } from "./claude.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("a Claude account's directory", () => {
  it("links in what the user set up and the conversations, and keeps the CLI's own bookkeeping apart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vgent-claude-home-"));
    dirs.push(root);
    const shared = join(root, "dot-claude");
    await mkdir(join(shared, "skills"), { recursive: true });
    await mkdir(join(shared, "backups"), { recursive: true });
    await writeFile(join(shared, "settings.json"), "{}");
    await writeFile(join(shared, ".claude.json"), "{}");
    const home = join(root, "accounts", "claude-0a1b2c3d");

    await prepareClaudeHome(home, shared);
    await prepareClaudeHome(home, shared);

    expect(await readlink(join(home, "settings.json"))).toBe(join(shared, "settings.json"));
    expect(await readlink(join(home, "skills"))).toBe(join(shared, "skills"));
    // Conversations are shared even before the user has any, so a task can move between accounts.
    expect(await readlink(join(home, "projects"))).toBe(join(shared, "projects"));
    expect((await lstat(join(shared, "projects"))).isDirectory()).toBe(true);
    await expect(lstat(join(home, ".claude.json"))).rejects.toThrow();
    await expect(lstat(join(home, "backups"))).rejects.toThrow();
    await expect(lstat(join(home, "CLAUDE.md"))).rejects.toThrow();
  });

  it("names the keychain item the way Claude Code does, and gives the machine's login no directory", () => {
    expect(claudeKeychainService(undefined)).toBe("Claude Code-credentials");
    const home = "/data/accounts/claude-0a1b2c3d";
    expect(claudeKeychainService(home)).toBe(`Claude Code-credentials-${createHash("sha256").update(home).digest("hex").slice(0, 8)}`);
    expect(claudeHomeOf("/data", "claude")).toBeUndefined();
    expect(claudeHomeOf("/data", "claude-0a1b2c3d")).toBe(home);
  });
});
