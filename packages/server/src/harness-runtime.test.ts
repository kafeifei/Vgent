import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, createHarnessRuntime, type HarnessRuntime } from "./harness-runtime.js";

/**
 * A pretend bootstrap directory and a pretend pnpm. "Installing" is writing the
 * package manifests the real thing would leave in `node_modules`, read off the
 * `package.json` that is in the directory at that moment — so an upgrade, a
 * failed upgrade and a restore all behave like the real tree does.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CLI = "@anthropic-ai/claude-code";
const SDK = "@anthropic-ai/claude-agent-sdk";

async function fixture(options: { busy?: boolean; brokenVersion?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vgent-rt-"));
  roots.push(root);
  const dir = join(root, ".harness-bootstrap", "claude-code");
  await mkdir(dir, { recursive: true });

  const syncNodeModules = async (): Promise<void> => {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      await mkdir(join(dir, "node_modules", name), { recursive: true });
      await writeFile(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
  };

  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { [CLI]: "2.1.245", [SDK]: "0.3.245" } }));
  await writeFile(join(dir, "pnpm-lock.yaml"), "lock: 2.1.245\n");
  await writeFile(join(dir, "pnpm-workspace.yaml"), `allowBuilds:\n  '${CLI}@2.1.245': true\n`);
  await syncNodeModules();

  const calls: string[] = [];
  let busy = options.busy === true;
  const runtime: HarnessRuntime = createHarnessRuntime({
    isBusy: async () => busy,
    dataDirs: { "claude-code": root, codex: join(root, "no-codex") },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    fetchJson: async (url) => {
      if (url.includes("claude-agent-sdk")) return { version: "0.3.278", claudeCodeVersion: "2.1.278" };
      return { version: "0.155.1" };
    },
    run: async (command, args, cwd) => {
      calls.push([command, ...args].join(" "));
      expect(cwd).toBe(dir);
      if (command === "pnpm" && args[0] === "add") {
        const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        for (const spec of args.filter((arg) => arg.includes("@", 1) && !arg.startsWith("--"))) {
          const at = spec.lastIndexOf("@");
          manifest.dependencies[spec.slice(0, at)] = spec.slice(at + 1);
        }
        await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
        await writeFile(join(dir, "pnpm-lock.yaml"), `lock: ${manifest.dependencies[CLI]}\n`);
        await syncNodeModules();
        return "";
      }
      if (command === "pnpm" && args[0] === "install") {
        await syncNodeModules();
        return "";
      }
      if (command === "pnpm") return "";
      // The CLI's `--version`.
      const installed = JSON.parse(await readFile(join(dir, "node_modules", CLI, "package.json"), "utf8")) as { version: string };
      if (installed.version === options.brokenVersion) throw new Error("claude: cannot execute binary file");
      return `${installed.version} (Claude Code)\n`;
    },
  });

  const claude = async () => (await runtime.status()).find((entry) => entry.engine === "claude-code")!;
  return { runtime, dir, root, calls, claude, setBusy: (next: boolean) => (busy = next) };
}

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("2.1.245", "2.1.278")).toBe(-1);
    expect(compareVersions("0.155.1", "0.149.1")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("createHarnessRuntime", () => {
  it("reports what is installed, and an engine that was never used as not installed", async () => {
    const { runtime } = await fixture();
    const [claude, codex] = await runtime.check();
    expect(claude).toMatchObject({ installed: "2.1.245", latest: "2.1.278", updateAvailable: true, unverified: false, busy: false });
    expect(codex).toMatchObject({ engine: "codex", latest: "0.155.1", updateAvailable: false });
    expect(codex?.installed).toBeUndefined();
  });

  it("moves the CLI and the SDK together, retargets the build allowlist, and waits for a good turn", async () => {
    const { runtime, dir, calls, claude } = await fixture();

    const after = await runtime.upgrade("claude-code");

    expect(after).toMatchObject({ installed: "2.1.278", updateAvailable: false, unverified: true, previous: "2.1.245" });
    expect(calls).toContain(`pnpm add --save-exact ${CLI}@2.1.278 ${SDK}@0.3.278 --store-dir .pnpm-store`);
    // Without this the new CLI's install script would be blocked by pnpm.
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.278': true`);

    await runtime.reportTurn("claude-code", { ok: true, produced: true });
    expect(await claude()).toMatchObject({ installed: "2.1.278", unverified: false });
    expect(calls).toContain("pnpm store prune --store-dir .pnpm-store");
  });

  it("refuses while a task of that engine is live, and touches nothing", async () => {
    const { runtime, calls } = await fixture({ busy: true });
    await expect(runtime.upgrade("claude-code")).rejects.toMatchObject({ code: "runtime_busy" });
    expect(calls).toEqual([]);
  });

  it("puts the old tree back when the new CLI does not start, and remembers the version", async () => {
    const { runtime, dir, claude } = await fixture({ brokenVersion: "2.1.278" });

    await expect(runtime.upgrade("claude-code")).rejects.toMatchObject({ code: "runtime_upgrade_failed" });

    const status = await claude();
    expect(status).toMatchObject({ installed: "2.1.245", unverified: false, bad: ["2.1.278"] });
    expect(status.lastError).toContain("已退回 2.1.245");
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.245': true`);
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.245\n");
  });

  it("rolls back by itself when the first turn after an upgrade dies with nothing to show", async () => {
    const { runtime, claude } = await fixture();
    await runtime.upgrade("claude-code");

    // A turn that produced output failed for its own reasons: the upgrade stands.
    await runtime.reportTurn("claude-code", { ok: false, produced: true });
    expect(await claude()).toMatchObject({ installed: "2.1.278", unverified: true });

    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    const status = await claude();
    expect(status).toMatchObject({ installed: "2.1.245", unverified: false, bad: ["2.1.278"] });
    expect(status.lastError).toContain("已自动退回 2.1.245");
    expect(status.previous).toBeUndefined();
  });

  it("upgrades on its own only what is idle, newer and not known bad", async () => {
    const idle = await fixture();
    await idle.runtime.autoUpgrade();
    expect(await idle.claude()).toMatchObject({ installed: "2.1.278", unverified: true });

    const live = await fixture({ busy: true });
    await live.runtime.autoUpgrade();
    expect(await live.claude()).toMatchObject({ installed: "2.1.245", updateAvailable: true });

    // Rolled back by hand: the same version is not put straight back.
    const burnt = await fixture();
    await burnt.runtime.upgrade("claude-code");
    await burnt.runtime.rollback("claude-code");
    await burnt.runtime.autoUpgrade();
    expect(await burnt.claude()).toMatchObject({ installed: "2.1.245", bad: ["2.1.278"] });
  });

  it("ignores turns of an engine it does not keep, and turns when nothing is pending", async () => {
    const { runtime, calls } = await fixture();
    await runtime.reportTurn("vgent", { ok: false, produced: false });
    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    expect(calls).toEqual([]);
  });
});
