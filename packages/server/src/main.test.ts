import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boolFlag, defaultWebDist, flagValue, resolveWebDist, shouldOpenBrowser } from "./main.js";

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
