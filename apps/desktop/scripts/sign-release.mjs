#!/usr/bin/env node
// Tauri signs the shell and sidecar, but native code inside server resources
// also needs a Developer ID signature before submitting the App to Apple.
import { execFileSync } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(desktopRoot, "..", "..");
const config = JSON.parse(await readFile(join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"));
const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? join(desktopRoot, "src-tauri/target"));
const app = join(targetDir, "release/bundle/macos/Vgent.app");
const run = (command, args) => execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }).trim();
const head = run("git", ["rev-parse", "HEAD"]);
if (head !== run("git", ["rev-parse", "main"]) || run("git", ["status", "--porcelain", "--untracked-files=no"])) {
  throw new Error("Release signing requires a clean checkout at main.");
}
const runtime = JSON.parse(await readFile(join(app, "Contents/Resources/server/runtime.json"), "utf8"));
if (runtime.gitSha !== head) throw new Error("App source commit does not match main.");
const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")]);
if (version !== config.version) throw new Error("App version does not match the desktop config.");
const mac = config.bundle.macOS;
if (!mac.hardenedRuntime || !/^Developer ID Application: /.test(mac.signingIdentity)) {
  throw new Error("Release signing requires Developer ID and hardened runtime.");
}
const entitlements = resolve(desktopRoot, "src-tauri", mac.entitlements);
const magic = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
async function nativeFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await nativeFiles(path));
    else if (entry.isFile()) {
      const file = await open(path, "r");
      try {
        const bytes = Buffer.alloc(4);
        await file.read(bytes, 0, 4, 0);
        if (magic.has(bytes.toString("hex"))) result.push(path);
      } finally {
        await file.close();
      }
    }
  }
  return result;
}
const files = await nativeFiles(app);
for (const path of [...files, app]) {
  run("codesign", ["--force", "--sign", mac.signingIdentity, "--options", "runtime", "--timestamp", "--entitlements", entitlements, path]);
}
for (const path of files) run("codesign", ["--verify", "--strict", path]);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`Signed Vgent ${version} (${head.slice(0, 7)}), including ${files.length} native binaries and libraries.`);
