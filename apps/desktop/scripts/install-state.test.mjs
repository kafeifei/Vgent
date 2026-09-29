import { describe, expect, it } from "vitest";
import { isRetiredPackage, retiredPackageInUse, runningStarts } from "./install-state.mjs";

const installed = "/Applications/Vgent.app";
const old = { path: "/Applications/.Vgent.app.old-20260929-121117", at: new Date(2026, 8, 29, 12, 11, 17).getTime() };
const line = (time, app) => `Tue Sep 29 ${time} 2026 ${app}/Contents/MacOS/vgent-node --port 0`;

describe("桌面安装时保留正在运行的包", () => {
  it("识别旧命名和保留 .app 名称的备份，排除安装暂存目录", () => {
    expect(["Vgent.app.old", "Vgent.app.old-20260929-121117", ".Vgent.app.old-20260929-121117"].every(isRetiredPackage)).toBe(true);
    expect(["Vgent.app", "Vgent.app.new", "Other.app"].some(isRetiredPackage)).toBe(false);
  });

  it("保留仍报告安装路径的旧进程所在包，安装后启动的新进程不占用旧包", () => {
    const before = runningStarts(line("12:10:00", installed), installed);
    const after = runningStarts(line("12:12:00", installed), installed);
    expect(retiredPackageInUse(old, -Infinity, before, installed)).toBe(true);
    expect(retiredPackageInUse(old, -Infinity, after, installed)).toBe(false);
    expect(retiredPackageInUse(old, old.at - 10_000, before, installed)).toBe(false);
  });

  it("在换包同一秒启动的进程让两边都保留", () => {
    const starts = runningStarts(line("12:11:17", installed), installed);
    expect(retiredPackageInUse(old, -Infinity, starts, installed)).toBe(true);
    expect(retiredPackageInUse({ path: `${old.path}-next`, at: old.at + 60_000 }, old.at, starts, installed)).toBe(true);
  });

  it("直接从备份包启动的进程按路径保留，不受换包时间限制", () => {
    for (const path of ["/Applications/Vgent.app.old-20260929-121117", `${old.path}/Vgent.app`]) {
      const starts = runningStarts(line("12:12:00", path), installed);
      expect(starts).toHaveLength(1);
      expect(retiredPackageInUse({ ...old, path: path.endsWith("/Vgent.app") ? old.path : path }, -Infinity, starts, installed)).toBe(true);
      expect(retiredPackageInUse({ ...old, path: "/Applications/.Vgent.app.old-other" }, -Infinity, starts, installed)).toBe(false);
    }
  });

  it("不把读取包路径的命令、其他应用、构建产物算成正在运行的安装包", () => {
    const output = [line("12:10:00", "/tmp/Vgent.app"), line("12:10:00", "/Applications/Other.app"),
      `Tue Sep 29 12:10:00 2026 codesign --verify ${installed}/Contents/MacOS/vgent-desktop`].join("\n");
    expect(runningStarts(output, installed)).toEqual([]);
  });
});
