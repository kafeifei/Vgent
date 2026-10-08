// Produce an immutable, signed companion runtime; only its pinned manifest enters the App.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function createRuntimeArchive({ desktopRoot, repoRoot, bundledNode, serverDir, webDir, gitSha, target }) {
  const config = JSON.parse(await readFile(join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const output = join(desktopRoot, ".local/runtime");
  const tree = join(output, "tree");
  await rm(tree, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  await copyFile(bundledNode, join(tree, "node"));
  await cp(serverDir, join(tree, "server"), { recursive: true });
  await cp(webDir, join(tree, "web"), { recursive: true });
  const run = (command, args) => execFileSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  const magic = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
  async function sign(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await sign(path);
      else if (entry.isFile()) {
        const file = await open(path, "r");
        const bytes = Buffer.alloc(4);
        try { await file.read(bytes, 0, 4, 0); } finally { await file.close(); }
        if (magic.has(bytes.toString("hex"))) {
          run("codesign", ["--force", "--sign", config.bundle.macOS.signingIdentity, "--options", "runtime", "--timestamp", "--entitlements", join(desktopRoot, "src-tauri/entitlements.plist"), path]);
          run("codesign", ["--verify", "--strict", path]);
        }
      }
    }
  }
  // The installer belongs to the runtime; end users do not need system pnpm.
  const pnpmVersion = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).packageManager.split("@")[1];
  const metadataResponse = await fetch(`https://registry.npmjs.org/pnpm/${pnpmVersion}`, { signal: AbortSignal.timeout(30_000) });
  if (!metadataResponse.ok) throw new Error("无法获取固定版本 pnpm 的下载清单");
  const metadata = await metadataResponse.json();
  if (metadata.version !== pnpmVersion || metadata.dist.tarball !== `https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz` || !metadata.dist.integrity.startsWith("sha512-")) throw new Error("pnpm 下载清单无效");
  const response = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`pnpm 下载失败：HTTP ${response.status}`);
  const pnpmBytes = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash("sha512").update(pnpmBytes).digest("base64")}` !== metadata.dist.integrity) throw new Error("pnpm 下载校验失败");
  const pnpmArchive = join(output, "pnpm.tgz");
  await writeFile(pnpmArchive, pnpmBytes);
  const tools = join(tree, "tools");
  await mkdir(tools);
  run("/usr/bin/tar", ["-xzf", pnpmArchive, "-C", tools]);
  const bin = join(tree, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pnpm"), '#!/bin/sh\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$root/node" "$root/tools/package/bin/pnpm.cjs" "$@"\n', { mode: 0o755 });
  const runtimePath = join(tree, "server/runtime.json");
  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  await writeFile(runtimePath, JSON.stringify({ ...runtime, version: config.version, pnpmVersion }, null, 2) + "\n");
  await sign(tree);
  // Native Codex is large and is not needed to open the workbench. Publish it
  // separately, keeping all vendor resources together for code-mode / voice.
  const codexPackage = join(tree, "server/node_modules", process.arch === "arm64" ? "@openai/codex-darwin-arm64" : "@openai/codex-darwin-x64");
  const codexName = `Vgent-codex-${target}-${gitSha}.tar.gz`;
  const codexArchive = join(output, codexName);
  run("/usr/bin/tar", ["-czf", codexArchive, "-C", codexPackage, "vendor"]);
  const codexBytes = await readFile(codexArchive);
  const codexManifest = {
    schema: 1, gitSha, target, version: JSON.parse(await readFile(join(tree, "server/node_modules/@openai/codex/package.json"), "utf8")).version,
    sha256: createHash("sha256").update(codexBytes).digest("hex"), size: codexBytes.length,
    url: `https://github.com/kafeifei/Vgent/releases/download/runtime-${gitSha}/${codexName}`,
  };
  await writeFile(join(tree, "server/codex-runtime.json"), JSON.stringify(codexManifest, null, 2) + "\n");
  await rm(codexPackage, { recursive: true, force: true });
  const name = `Vgent-runtime-${target}-${gitSha}.tar.gz`;
  const archive = join(output, name);
  run("/usr/bin/tar", ["-czf", archive, "-C", tree, "node", "server", "web", "bin", "tools"]);
  const bytes = await readFile(archive);
  const manifest = {
    schema: 1, gitSha, target, version: config.version,
    sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
    url: `https://github.com/kafeifei/Vgent/releases/download/runtime-${gitSha}/${name}`,
  };
  await writeFile(join(desktopRoot, "src-tauri/resources/bootstrap.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(output, "bootstrap.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`可下载运行环境：${archive}；请在发布 App 前上传至 runtime-${gitSha}。`);
}
