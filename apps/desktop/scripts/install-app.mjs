#!/usr/bin/env node
// 把 pnpm desktop:build 的产物装到 /Applications/Vgent.app。
// 先核对产物就是 main 上的当前提交和 build 号，再原子替换；换下来的旧包只在
// 没有 Vgent 进程可能在用时移进废纸篓，从不删除。不启动、不退出正在运行的 Vgent。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRetiredPackage, retiredPackageInUse, runningStarts } from "./install-state.mjs";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(desktopRoot, "..", "..");
const applications = "/Applications";
const installed = join(applications, "Vgent.app");
const targetDir = resolve(process.env.CARGO_TARGET_DIR ?? join(desktopRoot, "src-tauri", "target"));
const built = join(targetDir, "release", "bundle", "macos", "Vgent.app");

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const git = (...args) => run("git", args, repoRoot);
const fail = (message) => {
  console.error(`没有安装：${message}`);
  process.exit(1);
};
const pad = (n) => String(n).padStart(2, "0");
const stampOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

// 1. 产物必须来自 main 上的这个提交、这个 build 号。
const head = git("rev-parse", "HEAD");
if (head !== git("rev-parse", "main")) fail("当前提交不在 main 上，先把 main 快进到它再打包");
if (git("status", "--porcelain", "--untracked-files=no") !== "") fail("工作区有未提交的改动，产物不等于任何提交");
if (!existsSync(built)) fail(`找不到产物 ${built}，先 pnpm desktop:build`);
const config = JSON.parse(readFileSync(join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const { version } = config;
const team = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(config.bundle.macOS.signingIdentity)?.[1];
if (!team) fail("安装包必须使用固定的 Developer ID Application 签名，临时签名无法跨版本保留系统授权");
const signingRequirement = `=identifier ${JSON.stringify(config.identifier)} and anchor apple generic and certificate leaf[subject.OU] = "${team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
const builtVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(built, "Contents", "Info.plist")]);
if (builtVersion !== version) fail(`产物是 ${builtVersion}，这个提交是 ${version}；产物可能被别的会话的构建覆盖了`);
const builtSha = JSON.parse(readFileSync(join(built, "Contents", "Resources", "server", "runtime.json"), "utf8")).gitSha;
if (builtSha !== head) fail(`产物来自提交 ${builtSha}，不是当前的 ${head}`);

/** 同一卷上的 rename：瞬间完成，可以从废纸篓捞回，挂在上面的进程也不丢文件。 */
const moveToTrash = (path) => {
  const trash = join(homedir(), ".Trash");
  let dest = join(trash, basename(path));
  for (let i = 2; existsSync(dest); i++) dest = join(trash, `${basename(path)} ${i}`);
  renameSync(path, dest);
};

/** 旧包被换下的时间：本脚本写在名字里；更早的命名只能看改名时更新的 ctime。 */
const retiredAt = (name) => {
  const m = /\.old-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/.exec(name);
  if (m == null) return statSync(join(applications, name)).ctimeMs;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
};

// 2. 复制到旁边、验签，再两次 rename 换上去。
const staging = `${installed}.new`;
if (existsSync(staging)) moveToTrash(staging);
run("ditto", [built, staging]);
run("codesign", ["--verify", "--deep", "--strict", staging]);
run("codesign", ["--verify", "--test-requirement", signingRequirement, staging]);
// 旧包保留有效的 .app 名称，避免系统授权框显示 Vgent.app.old-<时间>。
const swappedAt = new Date();
const retired = join(applications, `.Vgent.app.old-${stampOf(swappedAt)}`);
if (existsSync(installed)) {
  mkdirSync(retired);
  try {
    renameSync(installed, join(retired, "Vgent.app"));
  } catch (error) {
    rmdirSync(retired);
    throw error;
  }
}
try {
  renameSync(staging, installed);
} catch (error) {
  if (existsSync(join(retired, "Vgent.app"))) {
    renameSync(join(retired, "Vgent.app"), installed);
    rmdirSync(retired);
  }
  throw error;
}
console.log(`已安装 Vgent ${version}（${head.slice(0, 7)}）到 ${installed}`);

// 3. 每个旧包在「上一个旧包换下」到「它自己换下」之间在岗；这段时间里启动、
//    现在还活着的进程都跑在它上面。边界那一秒两边都算，宁可多留。
const starts = runningStarts(execFileSync("ps", ["-axo", "lstart=,command="], {
  encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
}), installed);
const olds = readdirSync(applications)
  .filter(isRetiredPackage)
  .map((name) => ({ name, path: join(applications, name), at: retiredAt(name) }))
  .sort((a, b) => a.at - b.at);
let since = -Infinity;
for (const old of olds) {
  const inUse = retiredPackageInUse(old, since, starts, installed);
  if (inUse) {
    console.log(`留着 ${old.name}：还有 Vgent 进程在用它`);
  } else {
    moveToTrash(join(applications, old.name));
    console.log(`已移进废纸篓：${old.name}`);
  }
  since = old.at;
}
if (starts.length > 0) {
  console.log("Vgent 正在运行，进程仍是旧版；需要用户自己 ⌘Q 后重新打开。");
}
