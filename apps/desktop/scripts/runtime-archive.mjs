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
  await sign(tree);
  // Native Codex is large and is not needed to open the workbench. Publish it
  // separately, keeping all vendor resources together for code-mode / voice.
  const codexPackage = join(tree, "server/node_modules", process.arch === "arm64" ? "@openai/codex-darwin-arm64" : "@openai/codex-darwin-x64");
  const codexName = `Vgent-codex-${target}-${gitSha}.tar.gz`;
  const codexArchive = join(output, codexName);
  run("/usr/bin/tar", ["-czf", codexArchive, "-C", codexPackage, "vendor"]);
  const codexBytes = await readFile(codexArchive);
  const codexManifest = {
    schema: 1, gitSha, target,
    sha256: createHash("sha256").update(codexBytes).digest("hex"), size: codexBytes.length,
    url: `https://github.com/kafeifei/Vgent/releases/download/runtime-${gitSha}/${codexName}`,
  };
  await writeFile(join(tree, "server/codex-runtime.json"), JSON.stringify(codexManifest, null, 2) + "\n");
  await rm(codexPackage, { recursive: true, force: true });
  const name = `Vgent-runtime-${target}-${gitSha}.tar.gz`;
  const archive = join(output, name);
  run("/usr/bin/tar", ["-czf", archive, "-C", tree, "node", "server", "web"]);
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
