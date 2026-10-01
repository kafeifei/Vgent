/**
 * The desktop shell's own file chooser. The workbench is a remote page inside
 * Tauri (`http://127.0.0.1:<port>`), and `capabilities/main.json` grants that
 * origin a short list of commands, the dialog plugin's `open` among them (the
 * rest are notifications and the title bar's drag and zoom). This file uses only
 * `open`: the panel comes up instantly instead of waiting the ~2 s the
 * server-side `osascript` needs to register itself as a GUI app.
 */

type TauriDialogOpen = (options: { directory: boolean; multiple: boolean; title: string }) => Promise<unknown>;

interface TauriHost {
  __TAURI__?: { dialog?: { open?: TauriDialogOpen } };
}

/**
 * `undefined` means there is no Tauri here (a plain browser) and the caller
 * should fall back to the server chooser; `null` means the user cancelled.
 */
export async function pickNativePath(kind: "folder" | "file"): Promise<string | null | undefined> {
  const open = (globalThis as unknown as TauriHost).__TAURI__?.dialog?.open;
  if (typeof open !== "function") return undefined;
  const picked = await open({
    directory: kind === "folder",
    multiple: false,
    title: kind === "folder" ? "选择仓库目录" : "选择可执行文件",
  });
  return typeof picked === "string" ? picked : null;
}
