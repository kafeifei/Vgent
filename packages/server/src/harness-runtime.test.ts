import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

async function fixture(options: { busy?: boolean; brokenVersion?: string; failStagedAdd?: boolean; onStageAdd?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vgent-rt-"));
  roots.push(root);
  const dir = join(root, ".harness-bootstrap", "claude-code");
  await mkdir(dir, { recursive: true });

  const syncNodeModules = async (cwd: string): Promise<void> => {
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      await mkdir(join(cwd, "node_modules", name), { recursive: true });
      await writeFile(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
  };

  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { [CLI]: "2.1.245", [SDK]: "0.3.245" } }));
  await writeFile(join(dir, "pnpm-lock.yaml"), "lock: 2.1.245\n");
  await writeFile(join(dir, "pnpm-workspace.yaml"), `allowBuilds:\n  '${CLI}@2.1.245': true\n`);
  await syncNodeModules(dir);

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
      if (command === "pnpm" && args[0] === "add") {
        if (cwd !== dir) {
          await options.onStageAdd?.();
          if (options.failStagedAdd) throw new Error("ECONNRESET downloading package");
        }
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
        for (const spec of args.filter((arg) => arg.includes("@", 1) && !arg.startsWith("--"))) {
          const at = spec.lastIndexOf("@");
          manifest.dependencies[spec.slice(0, at)] = spec.slice(at + 1);
        }
        await writeFile(join(cwd, "package.json"), JSON.stringify(manifest));
        await writeFile(join(cwd, "pnpm-lock.yaml"), `lock: ${manifest.dependencies[CLI]}\n`);
        await syncNodeModules(cwd);
        await mkdir(join(cwd, "node_modules", ".bin"), { recursive: true });
        await writeFile(join(cwd, "node_modules", ".bin", "claude"), `NODE_PATH=${cwd}/node_modules/.pnpm\n`);
        return "";
      }
      if (command === "pnpm" && args[0] === "install") {
        expect(cwd).toBe(dir);
        await syncNodeModules(cwd);
        return "";
      }
      if (command === "pnpm") return "";
      // The CLI's `--version`.
      const installed = JSON.parse(await readFile(join(cwd, "node_modules", CLI, "package.json"), "utf8")) as { version: string };
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
    expect(calls.some((call) => call.startsWith(`pnpm add --save-exact ${CLI}@2.1.278 ${SDK}@0.3.278 --store-dir `))).toBe(true);
    expect(calls.filter((call) => call.startsWith("pnpm add "))).toHaveLength(1);
    // Without this the new CLI's install script would be blocked by pnpm.
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.278': true`);
    expect(await readFile(join(dir, ".vgent-previous", "node_modules", CLI, "package.json"), "utf8")).toContain("2.1.245");
    expect(await readFile(join(dir, "node_modules", ".bin", "claude"), "utf8")).toBe(`NODE_PATH=${dir}/node_modules/.pnpm\n`);

    await runtime.reportTurn("claude-code", { ok: true, produced: true });
    expect(await claude()).toMatchObject({ installed: "2.1.278", unverified: false });
    expect((await claude()).previous).toBeUndefined();
    expect(await stat(join(dir, ".vgent-previous")).catch(() => undefined)).toBeUndefined();
    expect(calls.some((call) => call.startsWith("pnpm store prune --store-dir "))).toBe(true);
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
    expect(status.lastError).toContain("未受影响");
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.245': true`);
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.245\n");
  });

  it("keeps the installed CLI usable throughout a failed download", async () => {
    let liveVersionDuringDownload = "";
    const { runtime, dir, claude, calls } = await fixture({
      failStagedAdd: true,
      onStageAdd: async () => {
        const manifest = JSON.parse(await readFile(join(dir, "node_modules", CLI, "package.json"), "utf8")) as { version: string };
        liveVersionDuringDownload = manifest.version;
      },
    });

    await expect(runtime.upgrade("claude-code")).rejects.toMatchObject({ code: "runtime_upgrade_failed" });
    expect(liveVersionDuringDownload).toBe("2.1.245");
    expect(await claude()).toMatchObject({ installed: "2.1.245", broken: false, bad: [] });
    expect((await claude()).lastError).toContain("未受影响");
    expect(calls.filter((call) => call.startsWith("pnpm add "))).toHaveLength(1);
  });

  it("does not replace the CLI if a task starts while the candidate downloads", async () => {
    let taskStarted = () => {};
    const { runtime, claude, calls, setBusy } = await fixture({ onStageAdd: async () => taskStarted() });
    taskStarted = () => setBusy(true);

    await expect(runtime.upgrade("claude-code")).rejects.toMatchObject({ code: "runtime_busy" });
    expect(await claude()).toMatchObject({ installed: "2.1.245", broken: false, bad: [] });
    expect(calls.filter((call) => call.startsWith("pnpm add "))).toHaveLength(1);
  });

  it("rolls back by itself when the first turn after an upgrade dies with nothing to show", async () => {
    const { runtime, claude, calls } = await fixture();
    await runtime.upgrade("claude-code");

    // A turn that produced output failed for its own reasons: the upgrade stands.
    await runtime.reportTurn("claude-code", { ok: false, produced: true });
    expect(await claude()).toMatchObject({ installed: "2.1.278", unverified: true });

    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    const status = await claude();
    expect(status).toMatchObject({ installed: "2.1.245", unverified: false, bad: ["2.1.278"] });
    expect(status.lastError).toContain("已自动退回 2.1.245");
    expect(status.previous).toBeUndefined();
    expect(calls.filter((call) => call.startsWith("pnpm install "))).toHaveLength(0);
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

  it("repairs an install that was cut off, without blaming the version", async () => {
    const { runtime, dir, root, claude } = await fixture();
    // What a quit mid-download leaves: the intent noted by a process that is
    // gone, the workspace file already retargeted, the packages unlinked.
    await mkdir(join(dir, ".vgent-previous"), { recursive: true });
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await writeFile(join(dir, ".vgent-previous", name), await readFile(join(dir, name), "utf8"));
    }
    await writeFile(join(dir, "pnpm-workspace.yaml"), `allowBuilds:\n  '${CLI}@2.1.278': true\n`);
    await rm(join(dir, "node_modules", CLI), { recursive: true });
    await rm(join(dir, "node_modules", SDK), { recursive: true });
    await writeFile(
      join(root, ".vgent-runtime.json"),
      JSON.stringify({ upgrading: { from: { [CLI]: "2.1.245", [SDK]: "0.3.245" }, to: { [CLI]: "2.1.278", [SDK]: "0.3.278" }, pid: 2 ** 22 + 12345, startedAt: "x" } }),
    );

    const status = await claude();

    expect(status).toMatchObject({ installed: "2.1.245", broken: false, bad: [] });
    expect(status.lastError).toContain("被打断");
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.245': true`);
    expect(await readFile(join(root, ".vgent-runtime.log"), "utf8")).toContain("was interrupted");
    // A routine check does not wipe the explanation.
    expect((await runtime.check())[0]?.lastError).toContain("被打断");
  });

  it("restores the saved module tree after a commit is interrupted between renames", async () => {
    const { root, dir, claude, calls } = await fixture();
    const backup = join(dir, ".vgent-previous");
    const stage = await mkdtemp(join(root, ".vgent-candidate-"));
    await mkdir(backup, { recursive: true });
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await writeFile(join(backup, name), await readFile(join(dir, name)));
    }
    await rename(join(dir, "node_modules"), join(backup, "node_modules"));
    await writeFile(
      join(root, ".vgent-runtime.json"),
      JSON.stringify({ upgrading: { from: { [CLI]: "2.1.245", [SDK]: "0.3.245" }, to: { [CLI]: "2.1.278", [SDK]: "0.3.278" }, pid: 2 ** 22 + 12345, startedAt: "x", stage } }),
    );

    expect(await claude()).toMatchObject({ installed: "2.1.245", broken: false, bad: [] });
    expect(calls.filter((call) => call.startsWith("pnpm install "))).toHaveLength(0);
    expect(await readFile(join(dir, "node_modules", CLI, "package.json"), "utf8")).toContain("2.1.245");
  });

  it("stops retrying on its own a version whose install was cut off twice", async () => {
    const { runtime, root, claude } = await fixture();
    const note = { from: { [CLI]: "2.1.245", [SDK]: "0.3.245" }, to: { [CLI]: "2.1.278", [SDK]: "0.3.278" }, pid: 2 ** 22 + 12345, startedAt: "x" };
    for (let round = 0; round < 2; round += 1) {
      await runtime.upgrade("claude-code");
      await runtime.rollback("claude-code");
      // Pretend that attempt never finished instead: forget the rollback's verdict, leave the note.
      await writeFile(join(root, ".vgent-runtime.json"), JSON.stringify({ ...JSON.parse(await readFile(join(root, ".vgent-runtime.json"), "utf8")), bad: [], upgrading: note }));
      await runtime.recover();
    }
    await runtime.autoUpgrade();
    expect(await claude()).toMatchObject({ installed: "2.1.245", updateAvailable: true });
    // By hand it still goes through.
    expect(await runtime.upgrade("claude-code")).toMatchObject({ installed: "2.1.278" });
  });

  it("leaves an install alone while the process that started it is still alive", async () => {
    const { root, dir, claude, calls } = await fixture();
    await rm(join(dir, "node_modules", CLI), { recursive: true });
    await writeFile(
      join(root, ".vgent-runtime.json"),
      JSON.stringify({ upgrading: { from: { [CLI]: "2.1.245" }, to: { [CLI]: "2.1.278" }, pid: process.ppid, startedAt: "x" } }),
    );
    expect(await claude()).toMatchObject({ broken: true });
    expect(calls).toEqual([]);
  });

  it("ignores turns of an engine it does not keep, and turns when nothing is pending", async () => {
    const { runtime, calls } = await fixture();
    await runtime.reportTurn("vgent", { ok: false, produced: false });
    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    expect(calls).toEqual([]);
  });
});
