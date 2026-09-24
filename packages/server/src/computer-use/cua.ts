import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, type ToolExec } from "../exec.js";

/** Cua's official macOS installer creates both of these paths. */
const DRIVER_PATHS = [
  join(homedir(), ".local", "bin", "cua-driver"),
  "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
];

export const CUA_INSTALL_URL = "https://cua.ai/docs/how-to-guides/driver/install";

export const CUA_TOOLS = [
  "list_apps", "list_windows", "get_window_state", "get_accessibility_tree", "get_desktop_state",
  "get_screen_size", "get_cursor_position", "get_browser_state", "verify_state", "zoom",
  "click", "double_click", "right_click", "scroll", "drag", "press_key", "hotkey",
  "type_text", "set_value", "invoke_menu", "launch_app", "bring_to_front",
] as const;

export interface CuaStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  running: boolean;
  permissionMode?: string;
  accessibility: boolean | null;
  screenRecording: boolean | null;
  ready: boolean;
  error?: string;
}

export interface CuaTestResult {
  ok: boolean;
  appCount: number;
  message: string;
}

const command = (exec: ToolExec, binary: string, args: string[], timeout = 5_000) =>
  exec(binary, args, { cwd: homedir(), timeout });

/** Keep the official install outside Vgent's bundle so macOS grants belong to CuaDriver.app. */
export async function findCuaDriver(paths: readonly string[] = DRIVER_PATHS): Promise<string | undefined> {
  for (const path of paths) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

export async function getCuaStatus(exec: ToolExec = runCommand, paths?: readonly string[]): Promise<CuaStatus> {
  const binaryPath = await findCuaDriver(paths);
  if (binaryPath == null) return { installed: false, running: false, accessibility: null, screenRecording: null, ready: false };

  const [version, daemon, permissions] = await Promise.all([
    command(exec, binaryPath, ["--version"]),
    command(exec, binaryPath, ["status"]),
    command(exec, binaryPath, ["permissions", "status", "--json"]),
  ]);
  const running = daemon.code === 0 && daemon.stdout.includes("daemon is running");
  const permissionMode = daemon.stdout.match(/^\s*permission mode:\s*(\S+)/m)?.[1];
  let accessibility: boolean | null = null;
  let screenRecording: boolean | null = null;
  if (permissions.code === 0) {
    try {
      const report = JSON.parse(permissions.stdout) as Record<string, unknown>;
      if (typeof report.accessibility === "boolean") accessibility = report.accessibility;
      if (typeof report.screen_recording === "boolean") screenRecording = report.screen_recording;
    } catch { /* A changed CLI response is unknown, never granted. */ }
  }
  const ready = running && accessibility === true && screenRecording === true;
  return {
    installed: true,
    binaryPath,
    ...(version.code === 0 ? { version: version.stdout.trim() } : {}),
    running,
    ...(permissionMode != null ? { permissionMode } : {}),
    accessibility,
    screenRecording,
    ready,
    ...(!ready && daemon.stderr.trim() !== "" ? { error: daemon.stderr.trim() } : {}),
  };
}

export async function requireCuaDriver(): Promise<string> {
  const status = await getCuaStatus();
  if (!status.installed) throw new Error("Cua Driver 未安装；请在设置 → Computer Use 中按官方指南安装");
  if (!status.running) throw new Error("Cua Driver 服务未运行；请在设置 → Computer Use 中启动");
  if (status.accessibility !== true || status.screenRecording !== true) {
    throw new Error("Cua Driver 还需要 macOS 辅助功能和屏幕录制权限；请在设置 → Computer Use 中完成授权");
  }
  return status.binaryPath!;
}

export function cuaMcpConfig(binaryPath: string) {
  return { name: "cua", command: binaryPath, args: ["mcp"] };
}

export function onlyCuaTools<T>(tools: Record<string, T>): Record<string, T> {
  const allowed = new Set<string>(CUA_TOOLS.map((name) => `cua__${name}`));
  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.has(name)));
}

export async function startCuaDriver(exec: ToolExec = runCommand): Promise<CuaStatus> {
  const current = await getCuaStatus(exec);
  if (!current.installed) return current;
  if (!current.running) {
    const result = await exec("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], { cwd: homedir(), timeout: 10_000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "无法启动 Cua Driver");
  }
  return getCuaStatus(exec);
}

export async function requestCuaPermissions(exec: ToolExec = runCommand): Promise<CuaStatus> {
  const binary = await findCuaDriver();
  if (binary == null) throw new Error("Cua Driver 未安装");
  const result = await command(exec, binary, ["permissions", "grant"], 120_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Cua Driver 授权未完成");
  return getCuaStatus(exec);
}

export async function testCuaDriver(exec: ToolExec = runCommand): Promise<CuaTestResult> {
  const binary = await requireCuaDriver();
  // `call` reads JSON arguments from stdin when omitted. execFile leaves that
  // pipe open, so pass the empty object explicitly instead of waiting forever.
  const result = await command(exec, binary, ["call", "list_apps", "{}"], 15_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Cua Driver 无法读取桌面应用");
  let appCount = 0;
  try {
    const report = JSON.parse(result.stdout) as { apps?: unknown };
    if (Array.isArray(report.apps)) appCount = report.apps.length;
  } catch { throw new Error("Cua Driver 返回了无法识别的桌面状态"); }
  return { ok: appCount > 0, appCount, message: appCount > 0 ? `已读取 ${appCount} 个桌面应用` : "没有读到桌面应用，请确认当前有图形界面会话" };
}
