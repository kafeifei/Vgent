/**
 * Where a notification actually goes out.
 *
 * In the desktop shell the workbench is a remote page (`http://127.0.0.1:<port>`)
 * and reaches the notification plugin through `window.__TAURI__`, exactly like
 * the folder picker reaches the dialog plugin; `capabilities/main.json` grants
 * that origin the three commands used below and nothing else. In a plain
 * browser it is the Web Notification API.
 */

import type { NotifyDecision } from "./notify";

type TauriNotification = {
  isPermissionGranted?: () => Promise<boolean>;
  requestPermission?: () => Promise<string>;
  sendNotification?: (options: { title: string; body?: string }) => void;
};

interface TauriHost {
  __TAURI__?: { notification?: TauriNotification };
}

/** The desktop shell's plugin, when this page is running inside it. */
function tauriNotification(): TauriNotification | undefined {
  const api = (globalThis as unknown as TauriHost).__TAURI__?.notification;
  return typeof api?.sendNotification === "function" ? api : undefined;
}

const webNotification = (): typeof Notification | undefined =>
  typeof Notification === "undefined" ? undefined : Notification;

/** Whether anything here could ever notify — the setting says so when it cannot. */
export function notificationsSupported(): boolean {
  return tauriNotification() != null || webNotification() != null;
}

/**
 * Ask for permission. Called from the click that turns 「系统通知」 on and from
 * nowhere else: the browser only honours the prompt inside a user gesture, and
 * asking on page load is exactly the thing every user hates. Resolves to
 * whether we may notify now.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const tauri = tauriNotification();
  if (tauri != null) {
    try {
      if ((await tauri.isPermissionGranted?.()) === true) return true;
      return (await tauri.requestPermission?.()) === "granted";
    } catch {
      return false;
    }
  }
  const api = webNotification();
  if (api == null) return false;
  if (api.permission === "granted") return true;
  if (api.permission === "denied") return false;
  try {
    return (await api.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Deliver one notification. Returns whether it went out, and logs the line it
 * sent — 「发了没有」 has to be checkable without watching the screen.
 *
 * `onClick` is best-effort: the Web Notification API hands us a click, so that
 * one also selects the task; the desktop plugin's click only raises the window,
 * which is the OS default and enough.
 */
export async function sendSystemNotification(decision: NotifyDecision, onClick?: () => void): Promise<boolean> {
  const sent = await deliver(decision, onClick);
  if (sent) console.info(`[通知] ${decision.title} — ${decision.body}`);
  return sent;
}

async function deliver(decision: NotifyDecision, onClick?: () => void): Promise<boolean> {
  const tauri = tauriNotification();
  if (tauri != null) {
    try {
      // The OS permission belongs to the app, not to a gesture, so it is fine
      // to make sure of it here; macOS only ever prompts once.
      if ((await tauri.isPermissionGranted?.()) !== true && (await tauri.requestPermission?.()) !== "granted") return false;
      tauri.sendNotification?.({ title: decision.title, body: decision.body });
      return true;
    } catch {
      return false;
    }
  }
  const api = webNotification();
  // Never prompts: permission is asked for in 设置, on the user's own click.
  if (api == null || api.permission !== "granted") return false;
  try {
    // One notification per task at a time: a second one on the same task
    // replaces the first instead of stacking up.
    const notification = new api(decision.title, { body: decision.body, tag: `vgent-${decision.threadId}` });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
