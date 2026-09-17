import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NotImplementedError, VgentServerError } from "./errors.js";

const execFileAsync = promisify(execFile);

/** The dialog is modal to the user, not to us; give them as long as they need. */
const PICKER_TIMEOUT_MS = 5 * 60_000;

/**
 * `tell me to activate` fronts the `osascript` process itself, which is what
 * owns the panel. Going through System Events instead would need the user to
 * grant Automation permission first, and the panel would not appear until then.
 */
const SCRIPT = ['tell me to activate', 'POSIX path of (choose folder with prompt "选择仓库目录")'];

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

export interface PickFolderOptions {
  /** Injected by tests; defaults to this host. */
  platform?: NodeJS.Platform;
  exec?: ExecFileFn;
}

/** `osascript` exits 1 with this on Cancel — a normal outcome, not a failure. */
function isCancelled(error: unknown): boolean {
  const text = `${(error as { stderr?: string } | null)?.stderr ?? ""}${(error as Error | null)?.message ?? ""}`;
  return text.includes("-128") || text.toLowerCase().includes("user canceled");
}

/**
 * Opens the native folder chooser and returns the picked absolute path, or
 * `null` when the user cancelled. Lives on the server so the browser and the
 * desktop shell share one code path — the desktop webview is a remote origin
 * and has no Tauri IPC of its own.
 */
export async function pickFolder(options: PickFolderOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new NotImplementedError("当前平台不支持原生选择器，请手动输入路径", "picker_unavailable");
  }
  const exec = options.exec ?? ((file, args, opts) => execFileAsync(file, [...args], opts));
  let stdout: string;
  try {
    ({ stdout } = await exec("osascript", SCRIPT.flatMap((line) => ["-e", line]), { timeout: PICKER_TIMEOUT_MS }));
  } catch (error) {
    if (isCancelled(error)) return null;
    throw new VgentServerError({
      message: `打开文件夹选择器失败：${(error as Error).message}`,
      status: 500,
      code: "picker_failed",
    });
  }
  // `POSIX path of` always ends in a slash; `/` itself must survive the trim.
  const path = stdout.trim().replace(/(?!^)\/+$/, "");
  return path.length > 0 ? path : null;
}
