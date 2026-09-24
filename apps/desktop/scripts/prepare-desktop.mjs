/**
 * Fills `src-tauri/binaries` and `src-tauri/resources` with everything the
 * `.app` needs to run offline: the official standalone Node runtime (never a
 * Homebrew-linked one), a self-contained `@vgent/server` tree, and the built web
 * app. Runs from `apps/desktop` as tauri's `beforeBuildCommand`.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");

const nodeVersion = "22.23.2";
/** sha256 of the official `node-v<version>-darwin-<arch>.tar.gz`. */
const targets = {
  arm64: { triple: "aarch64-apple-darwin", checksum: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6" },
  x64: { triple: "x86_64-apple-darwin", checksum: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026" },
};

const binariesDir = join(desktopRoot, "src-tauri", "binaries");
const serverDir = join(desktopRoot, "src-tauri", "resources", "server");
const webDir = join(desktopRoot, "src-tauri", "resources", "web");

const run = (command, args, cwd = repoRoot) => execFileSync(command, args, { cwd, stdio: "inherit" });

async function fetchNode(target) {
  const archiveName = `node-v${nodeVersion}-darwin-${process.arch}`;
  const cacheDir = join(desktopRoot, ".local", "node-runtime");
  const archivePath = join(cacheDir, `${archiveName}.tar.gz`);
  await mkdir(cacheDir, { recursive: true });
  let archive = await readFile(archivePath).catch(() => undefined);
  if (!archive) {
    console.log(`下载桌面内置 Node.js ${nodeVersion}…`);
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archiveName}.tar.gz`, {
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`Node 下载失败：HTTP ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  // Verify the bytes before anything ever unpacks or executes them.
  if (createHash("sha256").update(archive).digest("hex") !== target.checksum) {
    throw new Error("Node 下载校验失败，请删除 apps/desktop/.local/node-runtime 下对应压缩包后重试。");
  }
  await writeFile(archivePath, archive);
  run("tar", ["-xzf", archivePath, "-C", cacheDir, `${archiveName}/bin/node`, `${archiveName}/LICENSE`], cacheDir);
  const bundledNode = join(binariesDir, `vgent-node-${target.triple}`);
  await copyFile(join(cacheDir, archiveName, "bin", "node"), bundledNode);
  await chmod(bundledNode, 0o755);
  await copyFile(join(cacheDir, archiveName, "LICENSE"), join(serverDir, "NODE-LICENSE.txt"));
  return bundledNode;
}

/**
 * `pnpm deploy` is the only supported way to get a workspace package plus its
 * `workspace:*` siblings into one standalone tree. pnpm 10 refuses it on a
 * shared lockfile unless `--legacy` is passed (the alternative,
 * `inject-workspace-packages=true` in the root `.npmrc`, would change how the
 * whole repo installs). `--node-linker=hoisted` matters too: the default
 * symlink farm does not survive tauri's resource copy into the `.app`.
 */
async function deployServer() {
  await rm(serverDir, { recursive: true, force: true });
  run("pnpm", ["deploy", "--filter", "@vgent/server", "--prod", "--legacy", "--node-linker=hoisted", serverDir]);
  // `--node-linker=hoisted` puts every package at the top level, so presence is
  // a plain file check; `exports` maps make `require.resolve` unreliable here.
  for (const name of ["@saymiao/remote-core", "@microsoft/dev-tunnels-connections", "@microsoft/dev-tunnels-management", "@microsoft/dev-tunnels-contracts", "@microsoft/dev-tunnels-ssh", "@microsoft/dev-tunnels-ssh-tcp", "node-rsa", "ai", "hono", "@hono/node-server", "@openai/codex", "@ai-sdk/harness", "@ai-sdk/harness-claude-code", "@ai-sdk/harness-codex", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic", "@ai-sdk/google", "@ai-sdk/xai", "@ai-sdk/amazon-bedrock", "@vgent/engines", "@vgent/engine", "@vgent/providers"]) {
    await stat(join(serverDir, "node_modules", name, "package.json")).catch(() => {
      throw new Error(`内置服务缺少依赖 ${name}，pnpm deploy 结果不完整。`);
    });
  }
}

/** Starts the deployed server with the bundled Node and waits for its handshake. */
async function smokeTest(bundledNode) {
  const dataDir = await mkdtemp(join(tmpdir(), "vgent-desktop-smoke-"));
  const env = { ...process.env, VGENT_DESKTOP: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(bundledNode, ["--enable-source-maps", join(serverDir, "dist", "main.js"), "--port", "0", "--data-dir", dataDir, "--web-dist", join(repoRoot, "apps", "web", "dist")], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Attach before polling: if startup fails, its exit may arrive before finally.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  const connectionPath = join(dataDir, "connection.json");
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode != null) throw new Error(`内置服务提前退出（${child.exitCode}）：\n${log.join("")}`);
      const connection = await readFile(connectionPath, "utf8").then(JSON.parse).catch(() => undefined);
      if (connection?.pid === child.pid) {
        const response = await fetch(`${connection.url}/api/remote`, {
          headers: { "x-vgent-token": connection.token }, signal: AbortSignal.timeout(5000),
        });
        const remote = await response.json();
        if (!response.ok || remote.enabled !== false || remote.account !== null) {
          throw new Error("内置远程控制服务初始化失败。");
        }
        return connection.url;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`内置服务 30 秒内没有写出 connection.json：\n${log.join("")}`);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    await exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}

export async function prepareDesktop() {
  const target = targets[process.arch];
  if (process.platform !== "darwin" || !target) throw new Error("桌面打包目前只支持 macOS arm64 / x64。");
  await mkdir(binariesDir, { recursive: true });

  console.log("构建工作区…");
  // The main checkout is not necessarily installed: a new workspace dependency
  // lands in the lockfile with the commit, and `tsc -b` then fails on a package
  // that has no `node_modules`. `--frozen-lockfile` keeps this a no-op when the
  // tree is already current, and fails loudly when the lockfile is out of date
  // rather than quietly rewriting it during a release build.
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["-w", "build"]);
  run("pnpm", ["--filter", "@vgent/web", "build"]);

  console.log("打包内置服务…");
  // Deploy first: it owns `resources/server/`, and the Node license lands inside it.
  await deployServer();
  const bundledNode = await fetchNode(target);
  run(bundledNode, ["--input-type=module", "-e", 'await import("./dist/remote/host.js")'], serverDir);
  const url = await smokeTest(bundledNode);
  console.log(`内置服务自检通过（${url}）。`);

  await rm(webDir, { recursive: true, force: true });
  await cp(join(repoRoot, "apps", "web", "dist"), webDir, { recursive: true });

  const gitSha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  })();
  await writeFile(
    join(serverDir, "runtime.json"),
    `${JSON.stringify({ nodeVersion, target: target.triple, archiveSha256: target.checksum, gitSha, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`桌面资源已就绪：Node ${nodeVersion}（${target.triple}）、内置服务、Web 工作台。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareDesktop();
