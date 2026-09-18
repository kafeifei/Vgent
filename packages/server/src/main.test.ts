import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_LOCKED_EXIT_CODE, InstanceLockedError } from "./instance-lock.js";
import { boolFlag, defaultWebDist, describeStartupFailure, flagValue, resolveWebDist, shouldOpenBrowser, watchParentExit } from "./main.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vgent-main-"));
  dirs.push(dir);
  return dir;
}

describe("flagValue", () => {
  it("reads a space-separated flag", () => {
    expect(flagValue(["--port", "1234"], "port")).toBe("1234");
  });

  it("reads an `=`-joined flag", () => {
    expect(flagValue(["--port=1234"], "port")).toBe("1234");
  });

  it("is undefined when the flag is absent", () => {
    expect(flagValue([], "port")).toBeUndefined();
  });
});

describe("boolFlag", () => {
  it("is true for --foo", () => {
    expect(boolFlag(["--open"], "open")).toBe(true);
  });

  it("is false for --no-foo", () => {
    expect(boolFlag(["--no-open"], "open")).toBe(false);
  });

  it("is undefined when neither is present", () => {
    expect(boolFlag([], "open")).toBeUndefined();
  });
});

describe("defaultWebDist", () => {
  it("resolves apps/web/dist next to packages/server/{src,dist}/main.{ts,js}", () => {
    const fromSrc = defaultWebDist(pathToFileURL("/repo/packages/server/src/main.ts").href);
    const fromDist = defaultWebDist(pathToFileURL("/repo/packages/server/dist/main.js").href);
    expect(fromSrc).toBe("/repo/apps/web/dist");
    expect(fromDist).toBe("/repo/apps/web/dist");
  });
});

describe("resolveWebDist", () => {
  it("returns the explicit dir unconditionally, even if it doesn't exist", () => {
    expect(resolveWebDist("/explicit/dir", "/default/dir")).toBe("/explicit/dir");
  });

  it("returns the default dir when it contains index.html", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<!doctype html>");
    expect(resolveWebDist(undefined, dir)).toBe(dir);
  });

  it("returns undefined when the default dir has no index.html (unbuilt checkout)", async () => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    expect(resolveWebDist(undefined, dir)).toBeUndefined();
  });

  it("returns undefined when the default dir doesn't exist at all", () => {
    expect(resolveWebDist(undefined, "/does/not/exist")).toBeUndefined();
  });
});

describe("describeStartupFailure", () => {
  it("turns a taken data directory into the dedicated exit code and a message naming the owner", () => {
    const described = describeStartupFailure(
      new InstanceLockedError({ message: "占用", pid: 4321, lockPath: "/tmp/vgent-data/server.lock" }),
    );
    expect(described?.exitCode).toBe(INSTANCE_LOCKED_EXIT_CODE);
    expect(described?.message).toContain("Vgent 已在运行");
    expect(described?.message).toContain("4321");
    expect(described?.message).toContain("/tmp/vgent-data");
    expect(described?.message).toContain("/tmp/vgent-data/server.lock");
  });

  it("leaves every other failure to the caller", () => {
    expect(describeStartupFailure(new Error("端口不合法: abc"))).toBeUndefined();
  });
});

describe("watchParentExit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the server once the parent it was spawned from is gone", () => {
    vi.useFakeTimers();
    let ppid = 900;
    const onOrphaned = vi.fn();
    watchParentExit({ getPpid: () => ppid, onOrphaned, intervalMs: 10 });

    vi.advanceTimersByTime(50);
    expect(onOrphaned).not.toHaveBeenCalled();

    ppid = 1; // reparented to launchd: the shell is gone
    vi.advanceTimersByTime(10);
    expect(onOrphaned).toHaveBeenCalledTimes(1);

    // The watch is one-shot; it must not keep firing after it reported.
    vi.advanceTimersByTime(100);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("stops the server when the shell was already gone at the first sample", () => {
    vi.useFakeTimers();
    const onOrphaned = vi.fn();
    // Reparented to launchd before we ever looked: no change is coming.
    watchParentExit({ getPpid: () => 1, onOrphaned, intervalMs: 10 });

    expect(onOrphaned).not.toHaveBeenCalled(); // never synchronously, `stop` may not be wired yet
    vi.advanceTimersByTime(10);
    expect(onOrphaned).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });
});

describe("shouldOpenBrowser", () => {
  it("honors an explicit --open/--no-open over everything else", () => {
    expect(shouldOpenBrowser({ openFlag: true, isTTY: false, desktop: true, staticServing: false })).toBe(true);
    expect(shouldOpenBrowser({ openFlag: false, isTTY: true, desktop: false, staticServing: true })).toBe(false);
  });

  it("defaults to open only at a TTY, outside the desktop shell, with static serving on", () => {
    expect(shouldOpenBrowser({ openFlag: undefined, isTTY: true, desktop: false, staticServing: true })).toBe(true);
    expect(shouldOpenBrowser({ openFlag: undefined, isTTY: false, desktop: false, staticServing: true })).toBe(false);
    expect(shouldOpenBrowser({ openFlag: undefined, isTTY: true, desktop: true, staticServing: true })).toBe(false);
    expect(shouldOpenBrowser({ openFlag: undefined, isTTY: true, desktop: false, staticServing: false })).toBe(false);
  });
});
