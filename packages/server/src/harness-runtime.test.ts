import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessBootstrapRecipe } from "@vgent/engines";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapIdentity, compareVersions, createHarnessRuntime, type BootstrapRecipe, type HarnessRuntime } from "./harness-runtime.js";

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

/** An adapter recipe the way the Claude Code adapter lays one out. */
const recipeOf = (dependencies: Record<string, string>, bridge: string): BootstrapRecipe => ({
  harnessId: "claude-code",
  bootstrapDir: ".harness-bootstrap/claude-code",
  files: [
    { path: ".harness-bootstrap/claude-code/package.json", content: JSON.stringify({ dependencies }) },
    { path: ".harness-bootstrap/claude-code/pnpm-lock.yaml", content: `lock: ${dependencies[CLI]}\n` },
    { path: ".harness-bootstrap/claude-code/pnpm-workspace.yaml", content: `allowBuilds:\n  '${CLI}@${dependencies[CLI]}': true\n` },
    { path: ".harness-bootstrap/claude-code/bridge.mjs", content: bridge },
  ],
  commands: [{ command: "pnpm install --frozen-lockfile --store-dir .pnpm-store" }, { command: "./node_modules/.bin/claude --version" }],
});

async function fixture(options: { busy?: boolean; brokenVersion?: string; brokenAfterSwapVersion?: string; failStagedAdd?: boolean; onStageAdd?: () => Promise<void>; recipe?: () => BootstrapRecipe | undefined } = {}) {
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
  let latest = "278";
  const runtime: HarnessRuntime = createHarnessRuntime({
    isBusy: async () => busy,
    dataDirs: { "claude-code": root, codex: join(root, "no-codex"), opencode: join(root, "no-opencode") },
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    ...(options.recipe != null ? { bootstrapRecipe: async (engine) => (engine === "claude-code" ? options.recipe?.() : undefined) } : {}),
    fetchJson: async (url) => {
      if (url.includes("claude-agent-sdk")) return { version: `0.3.${latest}`, claudeCodeVersion: `2.1.${latest}` };
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
      if (cwd === dir && installed.version === options.brokenAfterSwapVersion) throw new Error("claude: relocated binary failed");
      return `${installed.version} (Claude Code)\n`;
    },
  });

  const claude = async () => (await runtime.status()).find((entry) => entry.engine === "claude-code")!;
  return { runtime, dir, root, calls, claude, setBusy: (next: boolean) => (busy = next), setLatest: (next: string) => (latest = next) };
}

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("2.1.245", "2.1.278")).toBe(-1);
    expect(compareVersions("0.155.1", "0.149.1")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("the adapters' own recipes", () => {
  // What `adoptRecipe` relies on: the bridge and the three project files flat
  // in the bootstrap directory, and the runtime pinned in its package.json.
  it.each([
    ["claude-code", [CLI, SDK]],
    ["codex", ["@openai/codex-sdk"]],
  ] as const)("%s lays its recipe out as expected", async (engine, pinned) => {
    const recipe = (await harnessBootstrapRecipe(engine))!;
    expect(recipe.bootstrapDir).toBe(`.harness-bootstrap/${engine}`);
    for (const file of recipe.files) expect(file.path).toMatch(new RegExp(`^\\.harness-bootstrap/${engine}/[a-z-]+\\.(json|yaml|mjs)$`));
    const manifest = JSON.parse(recipe.files.find((file) => file.path.endsWith("/package.json"))!.content) as { dependencies: Record<string, string> };
    for (const name of pinned) expect(manifest.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bootstrapIdentity(recipe)).toMatch(/^[0-9a-f]{16}$/);
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

  it.each(["manual", "automatic"])("allows %s upgrades to skip an unused release and preserves the original fallback", async (mode) => {
    const { runtime, dir, calls, claude, setLatest } = await fixture();
    await runtime.upgrade("claude-code");
    for (const next of ["279", "280"]) {
      setLatest(next);
      if (mode === "manual") await runtime.upgrade("claude-code");
      else await runtime.autoUpgrade();
      expect(await claude()).toMatchObject({ installed: `2.1.${next}`, previous: "2.1.245", unverified: true });
      expect(await readFile(join(dir, ".vgent-previous", "node_modules", CLI, "package.json"), "utf8")).toContain("2.1.245");
    }
    await runtime.rollback("claude-code");
    expect(await claude()).toMatchObject({ installed: "2.1.245", unverified: false, bad: ["2.1.280"] });
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.245\n");
    expect(calls.filter((call) => call.startsWith("pnpm install "))).toHaveLength(0);
  });

  it("uses the successful release as the next fallback after consecutive upgrades", async () => {
    const { runtime, claude, setLatest } = await fixture();
    await runtime.upgrade("claude-code");
    setLatest("279");
    await runtime.upgrade("claude-code");
    await runtime.reportTurn("claude-code", { ok: true, produced: true });
    setLatest("280");
    expect(await runtime.upgrade("claude-code")).toMatchObject({ installed: "2.1.280", previous: "2.1.279" });
    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    expect(await claude()).toMatchObject({ installed: "2.1.279", unverified: false });
  });

  it.each(["staged", "swapped"])("keeps the current release and original fallback when a consecutive upgrade fails while %s", async (phase) => {
    const { runtime, dir, claude, setLatest } = await fixture(phase === "staged" ? { brokenVersion: "2.1.279" } : { brokenAfterSwapVersion: "2.1.279" });
    await runtime.upgrade("claude-code");
    setLatest("279");
    await expect(runtime.upgrade("claude-code")).rejects.toMatchObject({ code: "runtime_upgrade_failed" });
    expect(await claude()).toMatchObject({ installed: "2.1.278", previous: "2.1.245", unverified: true, bad: ["2.1.279"] });
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.278\n");
    await runtime.rollback("claude-code");
    expect(await claude()).toMatchObject({ installed: "2.1.245", unverified: false });
  });

  it("does not let a late turn result remove the fallback during an upgrade", async () => {
    let report = async () => {};
    const { runtime, claude, setLatest } = await fixture({ onStageAdd: () => report() });
    await runtime.upgrade("claude-code");
    report = () => runtime.reportTurn("claude-code", { ok: true, produced: true });
    setLatest("279");
    await runtime.upgrade("claude-code");
    expect(await claude()).toMatchObject({ installed: "2.1.279", previous: "2.1.245", unverified: true });
    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    expect(await claude()).toMatchObject({ installed: "2.1.245", unverified: false });
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

  it.each(["before swap", "between renames", "after swap"])("recovers an interrupted consecutive upgrade %s without consuming the original fallback", async (phase) => {
    const { runtime, root, dir, claude, calls } = await fixture();
    await runtime.upgrade("claude-code");
    const stage = await mkdtemp(join(root, ".vgent-candidate-"));
    const undo = join(stage, ".vgent-replaced");
    await mkdir(undo);
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await writeFile(join(undo, name), await readFile(join(dir, name)));
    }
    if (phase !== "before swap") await rename(join(dir, "node_modules"), join(undo, "node_modules"));
    if (phase === "after swap") {
      for (const [name, version] of [[CLI, "2.1.279"], [SDK, "0.3.279"]]) {
        await mkdir(join(dir, "node_modules", name!), { recursive: true });
        await writeFile(join(dir, "node_modules", name!, "package.json"), JSON.stringify({ name, version }));
      }
      await writeFile(join(dir, "pnpm-lock.yaml"), "lock: 2.1.279\n");
    }
    const state = JSON.parse(await readFile(join(root, ".vgent-runtime.json"), "utf8"));
    await writeFile(join(root, ".vgent-runtime.json"), JSON.stringify({ ...state, upgrading: {
      from: { [CLI]: "2.1.278", [SDK]: "0.3.278" }, to: { [CLI]: "2.1.279", [SDK]: "0.3.279" },
      pid: 2 ** 22 + 12345, startedAt: "x", stage, preservePrevious: true,
    } }));

    expect(await claude()).toMatchObject({ installed: "2.1.278", previous: "2.1.245", unverified: true, bad: [] });
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.278\n");
    expect(await stat(stage).catch(() => undefined)).toBeUndefined();
    await runtime.rollback("claude-code");
    expect(await claude()).toMatchObject({ installed: "2.1.245", unverified: false });
    expect(calls.filter((call) => call.startsWith("pnpm install "))).toHaveLength(0);
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

  it("takes a new bridge on in place rather than let the adapter reinstall its older pins", async () => {
    let recipe: BootstrapRecipe | undefined;
    const { runtime, dir, root, calls, claude } = await fixture({ recipe: () => recipe });
    await writeFile(join(dir, "bridge.mjs"), "old bridge");
    await runtime.upgrade("claude-code");
    await runtime.reportTurn("claude-code", { ok: true, produced: true });

    // The next build patched the bridge; the adapter still pins what it always did.
    recipe = recipeOf({ [CLI]: "2.1.245", [SDK]: "0.3.245" }, "new bridge");
    await runtime.recover();

    expect(await readFile(join(dir, "bridge.mjs"), "utf8")).toBe("new bridge");
    expect(await stat(join(dir, `.bootstrap-${bootstrapIdentity(recipe)}.ok`))).toBeDefined();
    expect(await claude()).toMatchObject({ installed: "2.1.278" });
    expect(await readFile(join(dir, "pnpm-lock.yaml"), "utf8")).toBe("lock: 2.1.278\n");
    expect(await readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).toContain(`'${CLI}@2.1.278': true`);
    expect(calls.filter((call) => call.startsWith("pnpm install "))).toHaveLength(0);
    expect(await readFile(join(root, ".vgent-runtime.log"), "utf8")).toContain("kept 2.1.278 instead of reinstalling 2.1.245");
  });

  it("leaves to the adapter a recipe that brings anything new, and one it has already applied", async () => {
    let recipe: BootstrapRecipe | undefined;
    const { runtime, dir } = await fixture({ recipe: () => recipe });
    await writeFile(join(dir, "bridge.mjs"), "old bridge");
    const marker = (value: BootstrapRecipe) => stat(join(dir, `.bootstrap-${bootstrapIdentity(value)}.ok`)).catch(() => undefined);

    // A newer CLI, or a dependency the installed tree does not have: the adapter's install is what is wanted.
    for (const next of [
      recipeOf({ [CLI]: "2.1.300", [SDK]: "0.3.300" }, "newer pins"),
      recipeOf({ [CLI]: "2.1.245", [SDK]: "0.3.245", ws: "8.21.0" }, "new dependency"),
    ]) {
      recipe = next;
      await runtime.recover();
      expect(await marker(next)).toBeUndefined();
      expect(await readFile(join(dir, "bridge.mjs"), "utf8")).toBe("old bridge");
    }

    // Already installed by the adapter: not rewritten.
    recipe = recipeOf({ [CLI]: "2.1.245", [SDK]: "0.3.245" }, "same pins");
    await writeFile(join(dir, `.bootstrap-${bootstrapIdentity(recipe)}.ok`), "");
    await runtime.recover();
    expect(await readFile(join(dir, "bridge.mjs"), "utf8")).toBe("old bridge");

    // Never installed: nothing to keep.
    await rm(join(dir, "node_modules"), { recursive: true });
    recipe = recipeOf({ [CLI]: "2.1.100", [SDK]: "0.3.100" }, "first install");
    await runtime.recover();
    expect(await marker(recipe)).toBeUndefined();
  });

  it("ignores turns of an engine it does not keep, and turns when nothing is pending", async () => {
    const { runtime, calls } = await fixture();
    await runtime.reportTurn("vgent", { ok: false, produced: false });
    await runtime.reportTurn("claude-code", { ok: false, produced: false });
    expect(calls).toEqual([]);
  });
});

describe("managed first installation", () => {
  async function installer() {
    const root = await mkdtemp(join(tmpdir(), "vgent-install-test-"));
    roots.push(root);
    const recipe = await harnessBootstrapRecipe("opencode");
    if (recipe == null) throw new Error("Missing OpenCode recipe");
    let installs = 0;
    let fail = false;
    let release: (() => void) | undefined;
    let hold: Promise<void> | undefined;
    const runtime = createHarnessRuntime({
      // The requesting task may already be running: initial installation is safe.
      isBusy: async () => true,
      dataDirs: { "claude-code": join(root, "claude"), codex: join(root, "codex"), opencode: root },
      bootstrapRecipe: async engine => engine === "opencode" ? recipe : undefined,
      run: async (command, args, cwd) => {
        if (command === "pnpm") {
          expect(args[0]).toBe("install");
          installs++;
          await hold;
          if (fail) throw new Error("Download interrupted");
          const project = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies: Record<string, string> };
          for (const name of ["opencode-ai", "@opencode-ai/sdk"]) {
            await mkdir(join(cwd, "node_modules", name), { recursive: true });
            await writeFile(join(cwd, "node_modules", name, "package.json"), JSON.stringify({ version: project.dependencies[name] }));
          }
          return "";
        }
        return "1.18.31\n";
      },
    });
    return { runtime, root, recipe, count: () => installs, fail: (value: boolean) => { fail = value; }, hold: () => { hold = new Promise(resolve => { release = resolve; }); }, release: () => release?.() };
  }

  it("deduplicates manual and task installs and publishes the official bootstrap marker", async () => {
    const f = await installer();
    f.hold();
    const first = f.runtime.install("opencode");
    const second = f.runtime.install("opencode");
    expect(first).toBe(second);
    f.release();
    expect((await first).installed).toBe("1.18.31");
    const directory = join(f.root, f.recipe.bootstrapDir);
    expect(await readFile(join(directory, `.bootstrap-${bootstrapIdentity(f.recipe)}.ok`), "utf8")).toBe("ok\n");
    await f.runtime.install("opencode");
    expect(f.count()).toBe(1);
    await expect(f.runtime.upgrade("opencode")).rejects.toThrow("任务在运行");
  });

  it("retains a failed job's error, removes its staging directory and permits retry", async () => {
    const f = await installer();
    f.fail(true);
    await expect(f.runtime.install("opencode")).rejects.toThrow("Download interrupted");
    const status = (await f.runtime.status()).find(entry => entry.engine === "opencode")!;
    expect(status.installed).toBeUndefined();
    expect(status.working).toBe(false);
    expect(status.lastError).toContain("Download interrupted");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(f.root)).filter(name => name.startsWith(".vgent-install-"))).toEqual([]);
    f.fail(false);
    expect((await f.runtime.install("opencode")).installed).toBe("1.18.31");
    expect((await f.runtime.status()).find(entry => entry.engine === "opencode")!.lastError).toBeUndefined();
  });

  it("cleans an interrupted first install without affecting installed components", async () => {
    const f = await installer();
    const stage = join(f.root, ".vgent-install-interrupted");
    await mkdir(stage);
    await writeFile(join(f.root, ".vgent-runtime.json"), JSON.stringify({ installing: { stage, pid: 2147483647 } }));
    await f.runtime.recover();
    expect(await stat(stage).catch(() => undefined)).toBeUndefined();
    expect((await f.runtime.status()).find(entry => entry.engine === "opencode")!.lastError).toContain("中断");
    expect((await f.runtime.install("opencode")).installed).toBe("1.18.31");
  });
});
