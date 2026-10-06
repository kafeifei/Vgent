import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { installCodexArchive, validateCodexManifest } from "./native-codex-runtime.js";

const fixture = (bytes: Buffer) => {
  const gitSha = "a".repeat(40), target = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
  return { schema: 1, gitSha, target, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), url: `https://github.com/kafeifei/Vgent/releases/download/runtime-${gitSha}/Vgent-codex-${target}-${gitSha}.tar.gz` };
};

describe.skipIf(process.platform !== "darwin")("deferred native Codex", () => {
  it("rejects unexpected origins, targets and cache traversal", () => {
    const manifest = fixture(Buffer.from("fixture"));
    expect(() => validateCodexManifest(manifest)).not.toThrow();
    for (const change of [{ url: "https://evil.test/archive" }, { target: "../../escape" }, { sha256: "../escape" }, { size: -1 }]) {
      expect(() => validateCodexManifest({ ...manifest, ...change })).toThrow();
    }
  });
  it("uses a complete matching cache without accessing the network", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vgent-codex-cache-"));
    try {
      const manifest = fixture(Buffer.from("fixture"));
      const binary = join(dir, "vendor", manifest.target, "bin/codex");
      await mkdir(join(dir, "vendor", manifest.target, "bin"), { recursive: true });
      await writeFile(binary, "fixture");
      await writeFile(join(dir, "installed.sha256"), manifest.sha256);
      const network = vi.fn();
      expect(await installCodexArchive(manifest, dir, () => {}, network)).toBe(binary);
      expect(network).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects corrupt downloads before extraction, leaves old cache intact, and allows retry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vgent-codex-corrupt-"));
    const dir = join(parent, "cache");
    try {
      await mkdir(dir); await writeFile(join(dir, "old"), "keep");
      const manifest = fixture(Buffer.from("expected"));
      const network = vi.fn(async () => new Response("corrupt!"));
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(installCodexArchive(manifest, dir, () => {}, network as typeof fetch)).rejects.toThrow("校验失败");
      }
      expect(await readFile(join(dir, "old"), "utf8")).toBe("keep");
      expect(network).toHaveBeenCalledTimes(2);
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(parent)).toEqual(["cache"]);
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it("rejects interrupted and oversized downloads", async () => {
    const parent = await mkdtemp(join(tmpdir(), "vgent-codex-size-"));
    try {
      const manifest = fixture(Buffer.from("expected"));
      await expect(installCodexArchive(manifest, join(parent, "cache"), () => {}, async () => new Response("short"))).rejects.toThrow("校验失败");
      await expect(installCodexArchive(manifest, join(parent, "cache"), () => {}, async () => new Response("too many bytes"))).rejects.toThrow("大小不匹配");
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
});
