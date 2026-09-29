import { basename, dirname } from "node:path";

/** 兼容旧版改名后的包和新版保留 .app 名称的备份目录。 */
export const isRetiredPackage = (name) => name.startsWith("Vgent.app.old") || name.startsWith(".Vgent.app.old-");

/** ps 仍可能报告改名前的路径，也可能报告直接从备份包启动的路径。 */
export function runningStarts(output, installed) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return output.split("\n").flatMap((line) => {
    const m = /^\s*\w{3} (\w{3}) +(\d+) (\d\d):(\d\d):(\d\d) (\d{4})\s+(.*)$/.exec(line);
    if (m == null) return [];
    const end = m[7].indexOf("/Contents/MacOS/");
    if (end < 0) return [];
    const app = m[7].slice(0, end);
    const legacy = dirname(app) === dirname(installed) && basename(app).startsWith("Vgent.app.old");
    const backup = basename(app) === "Vgent.app" && dirname(dirname(app)) === dirname(installed)
      && basename(dirname(app)).startsWith(".Vgent.app.old-");
    if (app !== installed && !legacy && !backup) return [];
    return [{
      app,
      at: new Date(Number(m[6]), months.indexOf(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime(),
    }];
  });
}

/** 显式从备份启动的进程按路径认；保留原路径的进程按旧包的在岗时间认。 */
export function retiredPackageInUse(old, since, starts, installed) {
  return starts.some(({ app, at }) => app === old.path || app === `${old.path}/Vgent.app`
    || (app === installed && at >= since - 1000 && at <= old.at + 1000));
}
